import { io, type Socket } from 'socket.io-client';
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
  | { type: 'session:replaced'; roomCode: string }
  | { type: 'connection:state'; state: ConnectionState };

export interface PokerClient {
  createRoom(nickname: string, settings?: Partial<RoomSettings>): Promise<SessionInfo>;
  joinRoom(roomCode: string, nickname: string): Promise<SessionInfo>;
  reconnect(sessionToken: string): Promise<SessionInfo>;
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

export class SocketPokerClient implements PokerClient {
  private readonly listeners = new Set<(event: PokerClientEvent) => void>();
  private state: ConnectionState;

  constructor(private readonly socket: PokerSocket) {
    this.state = socket.connected ? 'connected' : 'connecting';
    socket.on('table:snapshot', (view) => this.publish({ type: 'table:snapshot', view }));
    socket.on('command:error', (error) => this.publish({ type: 'command:error', error }));
    socket.on('session:replaced', ({ roomCode }) => {
      this.publish({ type: 'session:replaced', roomCode });
    });
    socket.on('connect', () => this.setConnectionState('connected'));
    socket.on('disconnect', () => {
      this.setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
    });
    socket.on('connect_error', () => {
      this.setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
    });
    socket.io.on('reconnect_attempt', () => this.setConnectionState('reconnecting'));
  }

  createRoom(nickname: string, settings?: Partial<RoomSettings>): Promise<SessionInfo> {
    return this.send('room:create', {
      nickname,
      ...(settings === undefined ? {} : { settings }),
    });
  }

  joinRoom(roomCode: string, nickname: string): Promise<SessionInfo> {
    return this.send('room:join', { roomCode, nickname });
  }

  reconnect(sessionToken: string): Promise<SessionInfo> {
    return this.send('room:reconnect', { sessionToken });
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
}

export function createPokerClient(socket: PokerSocket = io()): PokerClient {
  return new SocketPokerClient(socket);
}
