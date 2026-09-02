import { describe, expect, it } from 'vitest';
import { createDeck, parseCard, shuffleDeck } from '../src/game/cards';
import { compareHands, evaluateSeven } from '../src/game/evaluator';
import type { HandCategory } from '../src/game/types';

const cards = (text: string) => text.split(' ').map(parseCard);

const CATEGORY_CASES: ReadonlyArray<{
  category: HandCategory;
  text: string;
  kickers: number[];
}> = [
  { category: 'high-card', text: 'As Kd 9c 7h 4s 3d 2c', kickers: [14, 13, 9, 7, 4] },
  { category: 'pair', text: 'Ah Ad Kc Qs 9d 2c 3h', kickers: [14, 13, 12, 9] },
  { category: 'two-pair', text: 'Ah Ad Kc Ks 9d 2c 3h', kickers: [14, 13, 9] },
  { category: 'trips', text: 'Ah Ad Ac Ks 9d 2c 3h', kickers: [14, 13, 9] },
  { category: 'straight', text: '9s 8d 7c 6h 5s Kd Qc', kickers: [9] },
  { category: 'flush', text: 'As Js 9s 7s 4s Kd Qc', kickers: [14, 11, 9, 7, 4] },
  { category: 'full-house', text: 'Ah Ad Ac Ks Kd 2c 3h', kickers: [14, 13] },
  { category: 'quads', text: 'Ah Ad Ac As Kd 2c 3h', kickers: [14, 13] },
  { category: 'straight-flush', text: '9s 8s 7s 6s 5s Kd Qc', kickers: [9] },
];

describe('cards', () => {
  it('parses every supported rank symbol', () => {
    expect(cards('2c 3d 4h 5s 6c 7d 8h 9s Tc Jd Qh Ks Ac')).toEqual([
      { rank: 2, suit: 'c' },
      { rank: 3, suit: 'd' },
      { rank: 4, suit: 'h' },
      { rank: 5, suit: 's' },
      { rank: 6, suit: 'c' },
      { rank: 7, suit: 'd' },
      { rank: 8, suit: 'h' },
      { rank: 9, suit: 's' },
      { rank: 10, suit: 'c' },
      { rank: 11, suit: 'd' },
      { rank: 12, suit: 'h' },
      { rank: 13, suit: 's' },
      { rank: 14, suit: 'c' },
    ]);
  });

  it.each(['', '10s', 'Asx', '1c', 'ac', 'TZ', ' Ts'])(
    'rejects malformed card text %j',
    (text) => {
      expect(() => parseCard(text)).toThrow(/Invalid card/);
    },
  );

  it('creates 52 unique cards and shuffles without mutating input', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, () => 0);
    expect(new Set(deck.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
    expect(shuffled).not.toBe(deck);
    expect(deck).toEqual(createDeck());
  });

  const invalidRandomInts: Array<[string, (max: number) => number]> = [
    ['negative', () => -1],
    ['equal to the exclusive upper bound', (max) => max],
    ['fractional', () => 0.5],
  ];

  it.each(invalidRandomInts)('rejects a %s shuffle index', (_label, randomInt) => {
    expect(() => shuffleDeck(createDeck(), randomInt)).toThrow(RangeError);
  });
});

describe('seven-card validation', () => {
  it.each([
    ['six', 'As Ks Qs Js Ts 2d'],
    ['eight', 'As Ks Qs Js Ts 2d 3c 4h'],
  ])('rejects a %s-card hand', (_label, text) => {
    expect(() => evaluateSeven(cards(text))).toThrow(/exactly 7 cards/);
  });

  it('rejects duplicate cards', () => {
    expect(() => evaluateSeven(cards('As As Qs Js Ts 2d 3c'))).toThrow(/7 unique cards/);
  });
});

describe('seven-card evaluation', () => {
  it.each(CATEGORY_CASES)('evaluates $category', ({ category, text, kickers }) => {
    expect(evaluateSeven(cards(text))).toMatchObject({ category, kickers });
  });

  it('orders all nine hand categories', () => {
    const ranked = CATEGORY_CASES.map(({ text }) => evaluateSeven(cards(text)));
    expect(ranked.map((hand) => hand.categoryValue)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    for (let index = 1; index < ranked.length; index += 1) {
      expect(compareHands(ranked[index]!, ranked[index - 1]!)).toBeGreaterThan(0);
    }
  });

  it('uses later kickers to break ties within the same category', () => {
    const pairWithNine = evaluateSeven(cards('Ah Ad Kc Qs 9d 2c 3h'));
    const pairWithEight = evaluateSeven(cards('As Ac Kd Qh 8s 2d 3c'));

    expect(pairWithNine.kickers).toEqual([14, 13, 12, 9]);
    expect(pairWithEight.kickers).toEqual([14, 13, 12, 8]);
    expect(compareHands(pairWithNine, pairWithEight)).toBeGreaterThan(0);
  });

  it('recognizes a wheel straight with five high', () => {
    expect(evaluateSeven(cards('As 2d 3c 4h 5s Kd Qc'))).toMatchObject({
      category: 'straight',
      kickers: [5],
    });
  });
});
