import type {
  GameErrorCode,
  HandPlayer,
  HandState,
  LegalActions,
  PlayerAction,
} from './types';

export class GameRuleError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = 'GameRuleError';
    this.code = code;
  }
}

const NO_ACTIONS: LegalActions = {
  canFold: false,
  canCheck: false,
  canCall: false,
  canBet: false,
  canRaise: false,
  canAllIn: false,
  callAmount: 0,
  minRaiseTo: null,
  maxRaiseTo: 0,
};

function playerById(state: HandState, playerId: string): HandPlayer | undefined {
  return state.players.find((player) => player.id === playerId);
}

export function getLegalActions(state: HandState, playerId: string): LegalActions {
  const player = playerById(state, playerId);
  if (
    !player ||
    state.actorId !== playerId ||
    state.street === 'showdown' ||
    state.street === 'complete' ||
    player.folded ||
    player.allIn
  ) {
    return { ...NO_ACTIONS };
  }

  const amountToMatch = Math.max(0, state.currentBet - player.streetBet);
  const callAmount = Math.min(amountToMatch, player.stack);
  const maxRaiseTo = player.streetBet + player.stack;
  const facingBet = amountToMatch > 0;
  const raiseReopened = !player.actedSinceFullRaise;
  const minimum = state.currentBet < state.bigBlind
    ? state.bigBlind
    : state.currentBet + state.lastFullRaiseSize;
  const canBet = !facingBet && state.currentBet === 0 && maxRaiseTo >= minimum;
  const canRaise =
    state.currentBet > 0 &&
    raiseReopened &&
    maxRaiseTo > state.currentBet &&
    maxRaiseTo >= minimum;
  const allInWouldRaise = maxRaiseTo > state.currentBet;

  return {
    canFold: true,
    canCheck: !facingBet,
    canCall: facingBet && callAmount > 0,
    canBet,
    canRaise,
    canAllIn: player.stack > 0 && (!allInWouldRaise || raiseReopened),
    callAmount,
    minRaiseTo: canBet || canRaise ? minimum : null,
    maxRaiseTo,
  };
}

function commit(player: HandPlayer, amount: number): void {
  player.stack -= amount;
  player.streetBet += amount;
  player.totalCommitted += amount;
  player.allIn = player.stack === 0;
}

function markFullRaise(state: HandState, raiserId: string, raiseSize: number): void {
  state.lastFullRaiseSize = raiseSize;
  for (const player of state.players) {
    if (!player.folded && !player.allIn) {
      player.actedSinceFullRaise = player.id === raiserId;
    }
  }
}

function requireAmount(action: PlayerAction): number {
  if (!('amount' in action) || !Number.isInteger(action.amount) || action.amount < 0) {
    throw new GameRuleError('INVALID_AMOUNT', 'Bet and raise amounts must be non-negative integers');
  }
  return action.amount;
}

export function applyBettingAction(state: HandState, action: PlayerAction): void {
  if (state.street === 'showdown' || state.street === 'complete' || state.actorId === null) {
    throw new GameRuleError('HAND_NOT_ACTIVE', 'The hand is not accepting player actions');
  }

  const player = playerById(state, action.playerId);
  if (!player) {
    throw new GameRuleError('UNKNOWN_PLAYER', `Unknown player: ${action.playerId}`);
  }
  if (state.actorId !== action.playerId) {
    throw new GameRuleError('NOT_PLAYER_TURN', `It is not ${action.playerId}'s turn`);
  }

  const legal = getLegalActions(state, action.playerId);

  switch (action.type) {
    case 'fold':
      player.folded = true;
      player.actedSinceFullRaise = true;
      break;
    case 'check':
      if (!legal.canCheck) {
        throw new GameRuleError('ILLEGAL_ACTION', 'Cannot check while facing a bet');
      }
      player.actedSinceFullRaise = true;
      break;
    case 'call':
      if (!legal.canCall) {
        throw new GameRuleError('ILLEGAL_ACTION', 'Cannot call without a bet to match');
      }
      commit(player, legal.callAmount);
      player.actedSinceFullRaise = true;
      break;
    case 'bet': {
      const amount = requireAmount(action);
      if (!legal.canBet) {
        throw new GameRuleError('ILLEGAL_ACTION', 'A bet is not legal in the current state');
      }
      if (legal.minRaiseTo === null || amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
        throw new GameRuleError('AMOUNT_OUT_OF_RANGE', 'Bet amount is outside the legal range');
      }
      commit(player, amount - player.streetBet);
      state.currentBet = amount;
      markFullRaise(state, player.id, amount);
      break;
    }
    case 'raise': {
      const amount = requireAmount(action);
      if (!legal.canRaise) {
        throw new GameRuleError('ILLEGAL_ACTION', 'A raise is not legal in the current state');
      }
      if (legal.minRaiseTo === null || amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
        throw new GameRuleError('AMOUNT_OUT_OF_RANGE', 'Raise amount is outside the legal range');
      }
      const previousBet = state.currentBet;
      const raiseSize = amount - previousBet;
      commit(player, amount - player.streetBet);
      state.currentBet = amount;
      markFullRaise(
        state,
        player.id,
        previousBet < state.bigBlind ? Math.max(state.bigBlind, raiseSize) : raiseSize,
      );
      break;
    }
    case 'all-in': {
      if (!legal.canAllIn) {
        throw new GameRuleError('ILLEGAL_ACTION', 'Cannot move all-in');
      }
      const previousBet = state.currentBet;
      const target = player.streetBet + player.stack;
      commit(player, player.stack);
      player.actedSinceFullRaise = true;
      if (target > previousBet) {
        const raiseSize = target - previousBet;
        const fullRaiseSize = previousBet < state.bigBlind && target >= state.bigBlind
          ? Math.max(state.bigBlind, raiseSize)
          : raiseSize;
        state.currentBet = target;
        if (fullRaiseSize >= state.lastFullRaiseSize) {
          markFullRaise(state, player.id, fullRaiseSize);
        }
      }
      break;
    }
  }

  player.lastAction = action.type;
}
