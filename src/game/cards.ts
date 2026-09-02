import type { Card, Rank, Suit } from './types';

const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_BY_SYMBOL: Readonly<Record<string, Rank>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export function parseCard(text: string): Card {
  const match = /^([2-9TJQKA])([cdhs])$/.exec(text);
  const rank = match ? RANK_BY_SYMBOL[match[1]!] : undefined;
  if (!match || rank === undefined) {
    throw new Error(`Invalid card: ${text}`);
  }

  return { rank, suit: match[2] as Suit };
}

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleDeck(
  deck: readonly Card[],
  randomInt: (max: number) => number,
): Card[] {
  const shuffled = deck.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError(`randomInt returned ${swapIndex} for max ${index + 1}`);
    }

    const current = shuffled[index]!;
    shuffled[index] = shuffled[swapIndex]!;
    shuffled[swapIndex] = current;
  }

  return shuffled;
}
