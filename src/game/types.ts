import type { Settlement } from './pots';

export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type HandCategory =
  | 'high-card'
  | 'pair'
  | 'two-pair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'full-house'
  | 'quads'
  | 'straight-flush';

export interface HandRank {
  category: HandCategory;
  categoryValue: number;
  kickers: number[];
  bestFive: Card[];
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export type PlayerAction =
  | { playerId: string; type: 'fold' | 'check' | 'call' | 'all-in' }
  | { playerId: string; type: 'bet' | 'raise'; amount: number };

export type PlayerActionType = PlayerAction['type'];

export interface HandSeat {
  id: string;
  stack: number;
}

export interface HandConfig {
  seats: readonly HandSeat[];
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  randomInt?: (max: number) => number;
}

export interface HandPlayer {
  id: string;
  stack: number;
  holeCards: Card[];
  streetBet: number;
  totalCommitted: number;
  folded: boolean;
  allIn: boolean;
  actedSinceFullRaise: boolean;
  lastFacedBet: number | null;
  lastAction: PlayerActionType | null;
}

export interface HandState {
  players: HandPlayer[];
  street: Street;
  currentBet: number;
  lastFullRaiseSize: number;
  actorId: string | null;
  dealerIndex: number;
  board: Card[];
  deck: Card[];
  smallBlind: number;
  bigBlind: number;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  callAmount: number;
  minRaiseTo: number | null;
  maxRaiseTo: number;
}

export type GameEvent =
  | { type: 'blind-posted'; playerId: string; amount: number; blind: 'small' | 'big' }
  | { type: 'player-acted'; action: PlayerAction }
  | { type: 'street-advanced'; street: Exclude<Street, 'preflop' | 'complete'>; cards: Card[] }
  | { type: 'uncontested-awarded'; playerId: string; amount: number }
  | {
      type: 'hand-settled';
      settlement: Settlement;
      revealedHands: Array<{ playerId: string; cards: Card[] }>;
    };

export interface HandTransition {
  state: HandState;
  events: GameEvent[];
}

export type GameErrorCode =
  | 'INVALID_HAND_CONFIG'
  | 'UNKNOWN_PLAYER'
  | 'NOT_PLAYER_TURN'
  | 'HAND_NOT_ACTIVE'
  | 'INVALID_AMOUNT'
  | 'ILLEGAL_ACTION'
  | 'AMOUNT_OUT_OF_RANGE';
