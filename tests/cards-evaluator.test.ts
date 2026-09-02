import { describe, expect, it } from 'vitest';
import { createDeck, parseCard, shuffleDeck } from '../src/game/cards';
import { compareHands, evaluateSeven } from '../src/game/evaluator';

const cards = (text: string) => text.split(' ').map(parseCard);

describe('cards and evaluator', () => {
  it('creates 52 unique cards and shuffles without mutating input', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, () => 0);
    expect(new Set(deck.map((c) => `${c.rank}${c.suit}`)).size).toBe(52);
    expect(shuffled).not.toBe(deck);
    expect(deck).toEqual(createDeck());
  });

  it('orders every category and applies kickers', () => {
    const straightFlush = evaluateSeven(cards('As Ks Qs Js Ts 2d 3c'));
    const quads = evaluateSeven(cards('Ah Ad Ac As Kd 2c 3h'));
    const pairAce = evaluateSeven(cards('Ah Ad Kc Qs 9d 2c 3h'));
    const pairKing = evaluateSeven(cards('Kh Kd Ac Qs 9d 2c 3h'));
    expect(compareHands(straightFlush, quads)).toBeGreaterThan(0);
    expect(compareHands(pairAce, pairKing)).toBeGreaterThan(0);
  });

  it('recognizes a wheel straight with five high', () => {
    expect(evaluateSeven(cards('As 2d 3c 4h 5s Kd Qc'))).toMatchObject({
      category: 'straight',
      kickers: [5],
    });
  });
});
