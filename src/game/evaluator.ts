import type { Card, HandCategory, HandRank } from './types';

const CATEGORY_VALUE: Readonly<Record<HandCategory, number>> = {
  'high-card': 0,
  pair: 1,
  'two-pair': 2,
  trips: 3,
  straight: 4,
  flush: 5,
  'full-house': 6,
  quads: 7,
  'straight-flush': 8,
};

interface RankGroup {
  rank: number;
  count: number;
}

function getRankGroups(cards: readonly Card[]): RankGroup[] {
  const counts = new Map<number, number>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

function getStraightHigh(ranks: readonly number[]): number | null {
  const descending = [...new Set(ranks)].sort((a, b) => b - a);
  if (descending.length !== 5) {
    return null;
  }

  if (
    descending[0] === 14 &&
    descending[1] === 5 &&
    descending[2] === 4 &&
    descending[3] === 3 &&
    descending[4] === 2
  ) {
    return 5;
  }

  const high = descending[0]!;
  for (let index = 1; index < descending.length; index += 1) {
    if (descending[index] !== high - index) {
      return null;
    }
  }

  return high;
}

function rankedHand(
  category: HandCategory,
  kickers: number[],
  cards: readonly Card[],
): HandRank {
  return {
    category,
    categoryValue: CATEGORY_VALUE[category],
    kickers,
    bestFive: cards.slice(),
  };
}

function evaluateFive(cards: readonly Card[]): HandRank {
  const ranksDescending = cards.map((card) => card.rank).sort((a, b) => b - a);
  const groups = getRankGroups(cards);
  const flush = cards.every((card) => card.suit === cards[0]!.suit);
  const straightHigh = getStraightHigh(ranksDescending);

  if (flush && straightHigh !== null) {
    return rankedHand('straight-flush', [straightHigh], cards);
  }

  const quads = groups.find((group) => group.count === 4);
  if (quads) {
    const kicker = groups.find((group) => group.count === 1)!.rank;
    return rankedHand('quads', [quads.rank, kicker], cards);
  }

  const trips = groups.find((group) => group.count === 3);
  const pair = groups.find((group) => group.count === 2);
  if (trips && pair) {
    return rankedHand('full-house', [trips.rank, pair.rank], cards);
  }

  if (flush) {
    return rankedHand('flush', ranksDescending, cards);
  }

  if (straightHigh !== null) {
    return rankedHand('straight', [straightHigh], cards);
  }

  if (trips) {
    const kickers = groups
      .filter((group) => group.count === 1)
      .map((group) => group.rank)
      .sort((a, b) => b - a);
    return rankedHand('trips', [trips.rank, ...kickers], cards);
  }

  const pairs = groups
    .filter((group) => group.count === 2)
    .map((group) => group.rank)
    .sort((a, b) => b - a);
  if (pairs.length === 2) {
    const kicker = groups.find((group) => group.count === 1)!.rank;
    return rankedHand('two-pair', [pairs[0]!, pairs[1]!, kicker], cards);
  }

  if (pairs.length === 1) {
    const kickers = groups
      .filter((group) => group.count === 1)
      .map((group) => group.rank)
      .sort((a, b) => b - a);
    return rankedHand('pair', [pairs[0]!, ...kickers], cards);
  }

  return rankedHand('high-card', ranksDescending, cards);
}

export function compareHands(a: HandRank, b: HandRank): number {
  const aScore = [a.categoryValue, ...a.kickers];
  const bScore = [b.categoryValue, ...b.kickers];

  for (let index = 0; index < Math.max(aScore.length, bScore.length); index += 1) {
    const difference = (aScore[index] ?? 0) - (bScore[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function evaluateSeven(cards: readonly Card[]): HandRank {
  if (cards.length !== 7) {
    throw new Error(`Expected exactly 7 cards, received ${cards.length}`);
  }

  if (new Set(cards.map((card) => `${card.rank}${card.suit}`)).size !== 7) {
    throw new Error('Expected 7 unique cards');
  }

  let best: HandRank | null = null;
  for (let firstExcluded = 0; firstExcluded < 6; firstExcluded += 1) {
    for (let secondExcluded = firstExcluded + 1; secondExcluded < 7; secondExcluded += 1) {
      const candidate = evaluateFive(
        cards.filter((_, index) => index !== firstExcluded && index !== secondExcluded),
      );
      if (best === null || compareHands(candidate, best) > 0) {
        best = candidate;
      }
    }
  }

  return best!;
}
