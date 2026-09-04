import { io, type Socket } from 'socket.io-client';
import { normalizeBasePath, pathWithinBase } from '../shared/basePath';
import type {
  ClientCommand,
  ClientCommandData,
  ClientCommandInput,
  ClientToServerEvents,
  CommandAck,
  CommandError,
  CommandResponse,
  RoomSettings,
  ServerToClientEvents,
  SessionInfo,
} from '../shared/protocol';

export type PokerCommand = ClientCommand;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type PokerClientEvent =
  | { type: 'table:snapshot'; view: Parameters<ServerToClientEvents['table:snapshot']>[0] }
  | { type: 'command:error'; error: CommandError }
  | { type: 'session:invalid'; error: CommandError }
  | { type: 'session:replaced'; roomCode: string }
  | { type: 'connection:state'; state: ConnectionState };

export interface PokerClient {
  createRoom(nickname: string, settings?: Partial<RoomSettings>): Promise<SessionInfo>;
  joinRoom(roomCode: string, nickname: string): Promise<SessionInfo>;
  reconnect(sessionToken: string): Promise<SessionInfo>;
  leaveRoom(localOnly?: boolean): Promise<void>;
  send<Command extends PokerCommand>(
    command: Command,
    input: ClientCommandInput<Command>,
  ): Promise<ClientCommandData<Command>>;
  subscribe(listener: (event: PokerClientEvent) => void): () => void;
}

export class PokerCommandError extends Error {
  readonly code: string;

  constructor(error: CommandError) {
    super(error.message);
    this.name = 'PokerCommandError';
    this.code = error.code;
  }
}

type PokerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type CommandEmitter = <Command extends PokerCommand>(
  command: Command,
  input: ClientCommandInput<Command>,
  acknowledge: CommandAck<ClientCommandData<Command>>,
) => void;

interface TransportRecovery {
  session: SessionInfo;
  acknowledgementReceived: boolean;
  snapshotReceived: boolean;
}

export class SocketPokerClient implements PokerClient {
  private readonly listeners = new Set<(event: PokerClientEvent) => void>();
  private state: ConnectionState;
  private boundSession?: SessionInfo;
  private recovery?: TransportRecovery;
  private replaced = false;

  constructor(private readonly socket: PokerSocket) {
    this.state = socket.connected ? 'connected' : 'connecting';
    socket.on('table:snapshot', (view) => {
      this.publish({ type: 'table:snapshot', view });
      const recovery = this.recovery;
      if (recovery !== undefined && recovery.session.roomCode === view.roomCode) {
        recovery.snapshotReceived = true;
        this.completeRecovery(recovery);
      }
    });
    socket.on('command:error', (error) => this.publish({ type: 'command:error', error }));
    socket.on('session:replaced', ({ roomCode }) => {
      this.replaced = true;
      this.recovery = undefined;
      this.publish({ type: 'session:replaced', roomCode });
    });
    socket.on('connect', () => this.handleConnect());
    socket.on('disconnect', () => {
      this.recovery = undefined;
      this.setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
    });
    socket.on('connect_error', () => {
      this.setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
    });
    socket.io.on('reconnect_attempt', () => this.setConnectionState('reconnecting'));
  }

  createRoom(nickname: string, settings?: Partial<RoomSettings>): Promise<SessionInfo> {
    return this.rememberSession(this.send('room:create', {
      nickname,
      ...(settings === undefined ? {} : { settings }),
    }));
  }

  joinRoom(roomCode: string, nickname: string): Promise<SessionInfo> {
    return this.rememberSession(this.send('room:join', { roomCode, nickname }));
  }

  reconnect(sessionToken: string): Promise<SessionInfo> {
    return this.rememberSession(this.send('room:reconnect', { sessionToken }));
  }

  async leaveRoom(localOnly = false): Promise<void> {
    if (!localOnly) await this.send('room:leave', {});
    this.boundSession = undefined;
    this.recovery = undefined;
    this.replaced = false;
  }

  send<Command extends PokerCommand>(
    command: Command,
    input: ClientCommandInput<Command>,
  ): Promise<ClientCommandData<Command>> {
    return new Promise((resolve, reject) => {
      const acknowledge = (response: CommandResponse<ClientCommandData<Command>>): void => {
        if (response.ok) {
          resolve(response.data);
          return;
        }
        reject(new PokerCommandError(response.error));
      };
      const emitCommand = this.socket.emit.bind(this.socket) as CommandEmitter;
      emitCommand(command, input, acknowledge);
    });
  }

  subscribe(listener: (event: PokerClientEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'connection:state', state: this.state });
    return () => this.listeners.delete(listener);
  }

  private publish(event: PokerClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setConnectionState(state: ConnectionState): void {
    this.state = state;
    this.publish({ type: 'connection:state', state });
  }

  private async rememberSession(pending: Promise<SessionInfo>): Promise<SessionInfo> {
    const session = await pending;
    this.boundSession = session;
    return session;
  }

  private handleConnect(): void {
    if (this.replaced) {
      this.setConnectionState('disconnected');
      return;
    }
    if (this.boundSession === undefined) {
      this.setConnectionState('connected');
      return;
    }

    const recovery: TransportRecovery = {
      session: this.boundSession,
      acknowledgementReceived: false,
      snapshotReceived: false,
    };
    this.recovery = recovery;
    this.setConnectionState('reconnecting');
    void this.send('room:reconnect', {
      sessionToken: recovery.session.sessionToken,
    }).then((session) => {
      if (this.recovery !== recovery) return;
      this.boundSession = session;
      recovery.session = session;
      recovery.acknowledgementReceived = true;
      this.completeRecovery(recovery);
    }).catch((error: unknown) => {
      if (this.recovery !== recovery) return;
      this.recovery = undefined;
      if (error instanceof PokerCommandError && error.code === 'INVALID_SESSION') {
        this.boundSession = undefined;
        this.publish({
          type: 'session:invalid',
          error: { code: error.code, message: error.message },
        });
        this.setConnectionState(this.socket.connected ? 'connected' : 'disconnected');
        return;
      }
      this.setConnectionState('disconnected');
    });
  }

  private completeRecovery(recovery: TransportRecovery): void {
    if (
      this.recovery !== recovery ||
      !recovery.acknowledgementReceived ||
      !recovery.snapshotReceived
    ) return;
    this.recovery = undefined;
    this.setConnectionState('connected');
  }
}

export function socketPathFor(basePath: string): string {
  return pathWithinBase(basePath, 'socket.io');
}

export function createPokerClient(options: {
  socket?: PokerSocket;
  basePath?: string;
} = {}): PokerClient {
  const basePath = normalizeBasePath(options.basePath ?? import.meta.env.BASE_URL);
  const socket = options.socket ?? io({ path: socketPathFor(basePath) });
  return new SocketPokerClient(socket);
}
