import { parseCard } from '../../src/game/cards';
import type { PlayerActionType } from '../../src/game/types';
import type { BotInput } from '../../src/server/ai';
import type { BotStyle } from '../../src/shared/protocol';

interface BotScenarioOptions {
  playerId?: string;
  style?: BotStyle;
  holeCards?: string;
  board?: string;
  legal?: readonly PlayerActionType[];
  callAmount?: number;
  minRaiseTo?: number;
  maxRaiseTo?: number;
  pot?: number;
  position?: number;
  effectiveStack?: number;
  actionHistory?: BotInput['actionHistory'];
}

export function botScenario(options: BotScenarioOptions = {}): BotInput {
  const legal = new Set<PlayerActionType>(options.legal ?? ['fold', 'check', 'bet', 'all-in']);
  const canBetOrRaise = legal.has('bet') || legal.has('raise');

  return {
    playerId: options.playerId ?? 'bot-1',
    style: options.style ?? 'balanced',
    holeCards: (options.holeCards ?? 'As Kd').split(' ').filter(Boolean).map(parseCard),
    board: (options.board ?? '').split(' ').filter(Boolean).map(parseCard),
    legalActions: {
      canFold: legal.has('fold'),
      canCheck: legal.has('check'),
      canCall: legal.has('call'),
      canBet: legal.has('bet'),
      canRaise: legal.has('raise'),
      canAllIn: legal.has('all-in'),
      callAmount: options.callAmount ?? (legal.has('call') ? 20 : 0),
      minRaiseTo: canBetOrRaise ? (options.minRaiseTo ?? 40) : null,
      maxRaiseTo: options.maxRaiseTo ?? 500,
    },
    pot: options.pot ?? 100,
    position: options.position ?? 0.5,
    actionHistory: options.actionHistory ?? [],
    effectiveStack: options.effectiveStack ?? 500,
  };
}
