import { evaluateSeven } from '../game/evaluator';
import type { Card, LegalActions, PlayerAction } from '../game/types';
import type { BotStyle } from '../shared/protocol';

export interface BotInput {
  playerId: string;
  style: BotStyle;
  holeCards: readonly Card[];
  board: readonly Card[];
  legalActions: LegalActions;
  pot: number;
  position: number;
  actionHistory: readonly PlayerAction[];
  effectiveStack: number;
}

interface StylePolicy {
  continueThreshold: number;
  raiseThreshold: number;
  jitter: number;
}

const STYLE_POLICY: Readonly<Record<BotStyle, StylePolicy>> = {
  tight: { continueThreshold: 0.46, raiseThreshold: 0.74, jitter: 0.02 },
  balanced: { continueThreshold: 0.39, raiseThreshold: 0.64, jitter: 0.035 },
  aggressive: { continueThreshold: 0.32, raiseThreshold: 0.53, jitter: 0.05 },
};

const POSTFLOP_CATEGORY_STRENGTH = [0.2, 0.42, 0.58, 0.68, 0.77, 0.83, 0.91, 0.97, 1] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function randomUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0.5;
}

function preflopStrength(holeCards: readonly Card[]): number {
  if (holeCards.length !== 2) {
    return 0;
  }

  const [first, second] = holeCards;
  const high = Math.max(first!.rank, second!.rank);
  const low = Math.min(first!.rank, second!.rank);
  const highNormalized = (high - 2) / 12;
  const lowNormalized = (low - 2) / 12;

  if (high === low) {
    return 0.6 + 0.4 * highNormalized;
  }

  const suitedBonus = first!.suit === second!.suit ? 0.08 : 0;
  const gap = high - low;
  const connectionBonus = gap === 1 ? 0.05 : gap === 2 ? 0.025 : 0;
  return clamp(
    0.18 + 0.38 * highNormalized + 0.18 * lowNormalized + suitedBonus + connectionBonus,
    0,
    1,
  );
}

function hasFourCardStraightDraw(cards: readonly Card[]): boolean {
  const ranks = new Set<number>(cards.map((card) => card.rank));
  if (ranks.has(14)) {
    ranks.add(1);
  }

  for (let low = 1; low <= 10; low += 1) {
    let present = 0;
    for (let rank = low; rank < low + 5; rank += 1) {
      if (ranks.has(rank)) {
        present += 1;
      }
    }
    if (present >= 4) {
      return true;
    }
  }

  return false;
}

function partialPostflopStrength(cards: readonly Card[]): number {
  const rankCounts = new Map<number, number>();
  const suitCounts = new Map<string, number>();
  for (const card of cards) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
    suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  }

  const groups = [...rankCounts.values()].sort((a, b) => b - a);
  const pairCount = groups.filter((count) => count === 2).length;
  let strength = groups[0] === 4
    ? 0.97
    : groups[0] === 3
      ? pairCount > 0 ? 0.91 : 0.68
      : pairCount >= 2
        ? 0.58
        : pairCount === 1
          ? 0.42
          : 0.2;

  const flushDraw = Math.max(0, ...suitCounts.values()) >= 4;
  const straightDraw = hasFourCardStraightDraw(cards);
  if (flushDraw && straightDraw) {
    strength = Math.max(strength, 0.64);
  } else if (flushDraw) {
    strength = Math.max(strength, 0.57);
  } else if (straightDraw) {
    strength = Math.max(strength, 0.55);
  }

  return strength;
}

function handStrength(input: BotInput): number {
  if (input.board.length === 0) {
    return preflopStrength(input.holeCards);
  }

  const knownCards = [...input.holeCards, ...input.board];
  if (knownCards.length === 7) {
    const rank = evaluateSeven(knownCards);
    const categoryBase = POSTFLOP_CATEGORY_STRENGTH[rank.categoryValue]!;
    const kickerAdjustment = ((rank.kickers[0] ?? 2) - 2) / 12 * 0.035;
    return clamp(categoryBase + kickerAdjustment, 0, 1);
  }

  return partialPostflopStrength(knownCards);
}

function decisionScore(input: BotInput, random: () => number): number {
  const policy = STYLE_POLICY[input.style];
  const pot = Math.max(0, input.pot);
  const callAmount = input.legalActions.canCall
    ? Math.max(0, input.legalActions.callAmount)
    : 0;
  const potOdds = callAmount / Math.max(1, pot + callAmount);
  const position = clamp(input.position, 0, 1);
  const stackToPot = Math.max(0, input.effectiveStack) / Math.max(1, pot);
  const stackAdjustment = clamp((4 - stackToPot) * 0.01, -0.03, 0.03);
  const priorAggression = input.actionHistory.filter(
    (action) => action.type === 'bet' || action.type === 'raise' || action.type === 'all-in',
  ).length;
  const historyAdjustment = -Math.min(0.08, priorAggression * 0.025);
  const jitter = (randomUnit(random) - 0.5) * 2 * policy.jitter;

  return clamp(
    handStrength(input)
      + (position - 0.5) * 0.06
      - potOdds * 0.35
      + stackAdjustment
      + historyAdjustment
      + jitter,
    0,
    1,
  );
}

function sizedAggression(input: BotInput, score: number): PlayerAction | null {
  const legal = input.legalActions;
  const type = legal.canRaise ? 'raise' : legal.canBet ? 'bet' : null;
  if (type === null || legal.minRaiseTo === null) {
    return null;
  }

  const pot = Math.max(0, input.pot);
  const stackToPot = Math.max(0, input.effectiveStack) / Math.max(1, pot);
  if (score >= 0.9 && stackToPot <= 1.25 && legal.canAllIn) {
    return { playerId: input.playerId, type: 'all-in' };
  }

  const fraction = input.style === 'aggressive' || score >= 0.9 ? 0.75 : 0.5;
  const amount = clamp(
    Math.round(pot * fraction),
    Math.ceil(legal.minRaiseTo),
    Math.floor(legal.maxRaiseTo),
  );
  if (!Number.isInteger(amount) || amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
    return null;
  }

  return { playerId: input.playerId, type, amount };
}

function simpleAction(input: BotInput, type: 'fold' | 'check' | 'call' | 'all-in'): PlayerAction {
  return { playerId: input.playerId, type };
}

function firstLegalAction(input: BotInput): PlayerAction {
  const legal = input.legalActions;
  if (legal.canCheck) return simpleAction(input, 'check');
  if (legal.canCall) return simpleAction(input, 'call');
  if (legal.canFold) return simpleAction(input, 'fold');
  if (legal.canAllIn) return simpleAction(input, 'all-in');

  const aggression = sizedAggression(input, 0);
  if (aggression) return aggression;
  throw new Error('Bot was asked to act without a legal action');
}

export function chooseBotAction(input: BotInput, random: () => number): PlayerAction {
  const score = decisionScore(input, random);
  const policy = STYLE_POLICY[input.style];
  const legal = input.legalActions;

  if (score >= policy.raiseThreshold) {
    const aggression = sizedAggression(input, score);
    if (aggression) {
      return aggression;
    }
    if (legal.canAllIn && score >= 0.82) {
      return simpleAction(input, 'all-in');
    }
  }

  if (score >= policy.continueThreshold) {
    if (legal.canCall) return simpleAction(input, 'call');
    if (legal.canCheck) return simpleAction(input, 'check');
    if (legal.canAllIn) return simpleAction(input, 'all-in');
  }

  if (legal.canCheck) return simpleAction(input, 'check');
  if (legal.canFold) return simpleAction(input, 'fold');
  return firstLegalAction(input);
}

export function botDelayMs(random: () => number): number {
  return Math.floor(600 + randomUnit(random) * 1_200);
}
