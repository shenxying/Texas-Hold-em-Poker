import type { Card, LegalActions } from '../game/types';

export interface RoomSettings {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}

export type BotStyle = 'tight' | 'balanced' | 'aggressive';

export interface ChatMessage {
  id: number;
  kind: 'player' | 'system';
  text: string;
  sentAt: number;
  sender?: {
    playerId: string;
    nickname: string;
    seatIndex: number;
  };
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
