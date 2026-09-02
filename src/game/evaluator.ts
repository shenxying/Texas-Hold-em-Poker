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

function straightHigh(ranks: readonly number[]): number | null {
  const uniqueDescending = [...new Set(ranks)].sort((a, b) => b - a);
  if (uniqueDescending.length !== 5) {
    return null;
  }

  if (uniqueDescending.join(',') === '14,5,4,3,2') {
    return 5;
  }

  const high = uniqueDescending[0]!;
  const low = uniqueDescending[4]!;
  return high - low === 4 ? high : null;
}

function rankGroups(cards: readonly Card[]): RankGroup[] {
  const counts = new Map<number, number>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

function handRank(category: HandCategory, kickers: number[], cards: readonly Card[]): HandRank {
  return {
    category,
    categoryValue: CATEGORY_VALUE[category],
    kickers,
    bestFive: cards.slice(),
  };
}

function evaluateFive(cards: readonly Card[]): HandRank {
  const ranksDescending = cards.map((card) => card.rank).sort((a, b) => b - a);
  const groups = rankGroups(cards);
  const flush = cards.every((card) => card.suit === cards[0]!.suit);
  const highStraight = straightHigh(ranksDescending);

  if (flush && highStraight !== null) {
    return handRank('straight-flush', [highStraight], cards);
  }

  const quads = groups.find((group) => group.count === 4);
  if (quads) {
    const kicker = groups.find((group) => group.count === 1)!.rank;
    return handRank('quads', [quads.rank, kicker], cards);
  }

  const trips = groups.find((group) => group.count === 3);
  const pair = groups.find((group) => group.count === 2);
  if (trips && pair) {
    return handRank('full-house', [trips.rank, pair.rank], cards);
  }

  if (flush) {
    return handRank('flush', ranksDescending, cards);
  }

  if (highStraight !== null) {
    return handRank('straight', [highStraight], cards);
  }

  if (trips) {
    const kickers = groups
      .filter((group) => group.count === 1)
      .map((group) => group.rank)
      .sort((a, b) => b - a);
    return handRank('trips', [trips.rank, ...kickers], cards);
  }

  const pairs = groups
    .filter((group) => group.count === 2)
    .map((group) => group.rank)
    .sort((a, b) => b - a);
  if (pairs.length === 2) {
    const kicker = groups.find((group) => group.count === 1)!.rank;
    return handRank('two-pair', [pairs[0]!, pairs[1]!, kicker], cards);
  }

  if (pairs.length === 1) {
    const kickers = groups
      .filter((group) => group.count === 1)
      .map((group) => group.rank)
      .sort((a, b) => b - a);
    return handRank('pair', [pairs[0]!, ...kickers], cards);
  }

  return handRank('high-card', ranksDescending, cards);
}

export function compareHands(a: HandRank, b: HandRank): number {
  const aScore = [a.categoryValue, ...a.kickers];
  const bScore = [b.categoryValue, ...b.kickers];
  const scoreLength = Math.max(aScore.length, bScore.length);

  for (let index = 0; index < scoreLength; index += 1) {
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

  const uniqueCards = new Set(cards.map((card) => `${card.rank}${card.suit}`));
  if (uniqueCards.size !== cards.length) {
    throw new Error('Expected 7 unique cards');
  }

  let best: HandRank | null = null;
  for (let firstExcluded = 0; firstExcluded < 6; firstExcluded += 1) {
    for (let secondExcluded = firstExcluded + 1; secondExcluded < 7; secondExcluded += 1) {
      const fiveCards = cards.filter(
        (_, index) => index !== firstExcluded && index !== secondExcluded,
      );
      const candidate = evaluateFive(fiveCards);
      if (best === null || compareHands(candidate, best) > 0) {
        best = candidate;
      }
    }
  }

  return best!;
}
