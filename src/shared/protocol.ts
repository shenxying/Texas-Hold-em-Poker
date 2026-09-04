import type { Card, LegalActions } from '../game/types';

export interface RoomSettings {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}

export type BotStyle = 'tight' | 'balanced' | 'aggressive';

export interface ChatMessageSender {
  playerId: string;
  nickname: string;
  seatIndex: number;
}

export interface ChatMessage {
  id: number;
  kind: 'player' | 'system';
  text: string;
  sentAt: number;
  sender?: ChatMessageSender;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  streetBet: number;
  connected: boolean;
  isBot: boolean;
  botStyle?: BotStyle;
  isHost: boolean;
  folded: boolean;
  allIn: boolean;
  lastAction?: string;
  holeCardCount: number;
  holeCards?: Card[];
}

export interface TableView {
  version: number;
  roomCode: string;
  settings: RoomSettings;
  phase: 'lobby' | 'playing' | 'between-hands';
  players: PublicPlayer[];
  board: Card[];
  pots: Array<{ amount: number }>;
  actorId?: string;
  dealerSeatIndex?: number;
  legalActions?: LegalActions;
  actionDeadline?: number;
  waitingPosition?: number;
  messages: ChatMessage[];
}

export interface CommandError {
  code: string;
  message: string;
}

export type CommandResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: CommandError };

export type CommandAck<T> = (response: CommandResponse<T>) => void;

export interface SessionInfo {
  roomCode: string;
  sessionToken: string;
  playerId: string;
  waitingPosition?: number;
}

export type ClientPlayerAction =
  | { type: 'fold' | 'check' | 'call' | 'all-in' }
  | { type: 'bet' | 'raise'; amount: number };

export interface ClientToServerEvents {
  'room:create': (
    input: { nickname: string; settings?: Partial<RoomSettings> },
    ack: CommandAck<SessionInfo>,
  ) => void;
  'room:join': (
    input: { roomCode: string; nickname: string },
    ack: CommandAck<SessionInfo>,
  ) => void;
  'room:reconnect': (
    input: { sessionToken: string },
    ack: CommandAck<SessionInfo>,
  ) => void;
  'room:leave': (
    input: Record<string, never>,
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'room:update-settings': (
    input: { settings: Partial<RoomSettings> },
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'room:add-bot': (
    input: { style: BotStyle },
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'room:remove-bot': (
    input: { playerId: string },
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'room:reset-stack': (
    input: { playerId: string },
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'game:start': (
    input: Record<string, never>,
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'game:act': (
    input: ClientPlayerAction,
    ack: CommandAck<Record<string, never>>,
  ) => void;
  'chat:send': (
    input: { text: string },
    ack: CommandAck<{ message: ChatMessage }>,
  ) => void;
}

export interface ServerToClientEvents {
  'table:snapshot': (view: TableView) => void;
  'command:error': (error: CommandError) => void;
  'session:replaced': (input: { roomCode: string }) => void;
}

export type ClientCommand = keyof ClientToServerEvents;

export type ClientCommandInput<Command extends ClientCommand> =
  Parameters<ClientToServerEvents[Command]>[0];

export type ClientCommandData<Command extends ClientCommand> =
  Parameters<ClientToServerEvents[Command]>[1] extends CommandAck<infer Data>
    ? Data
    : never;
