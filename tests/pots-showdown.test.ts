import { describe, expect, it } from 'vitest';
import { advanceAutomatic } from '../src/game/engine';
import { buildPots, settleShowdown } from '../src/game/pots';
import { handAtShowdown, handWithMainAndSidePotWinners } from './support/hands';

describe('pots and showdown', () => {
  it('creates eligible side pots from unequal all-ins', () => {
    const pots = buildPots([
      { id: 'a', totalCommitted: 100, folded: false },
      { id: 'b', totalCommitted: 300, folded: false },
      { id: 'c', totalCommitted: 500, folded: false },
      { id: 'd', totalCommitted: 500, folded: true },
    ] as never);
    expect(pots).toEqual([
      { amount: 400, eligiblePlayerIds: ['a', 'b', 'c'] },
      { amount: 600, eligiblePlayerIds: ['b', 'c'] },
      { amount: 400, eligiblePlayerIds: ['c'] },
    ]);
  });

  it('splits ties and gives odd chips left of the dealer', () => {
    const state = handAtShowdown({ dealerIndex: 0, pot: 101, tiedPlayerIds: ['p1', 'p2'] });
    expect(settleShowdown(state).payouts).toEqual({ p1: 50, p2: 51 });
  });

  it('pays a player whose valid id is __proto__ without losing chips', () => {
    const state = handAtShowdown({
      dealerIndex: 0,
      pot: 100,
      tiedPlayerIds: ['__proto__', 'p2'],
    });
    const settlement = settleShowdown(state);
    const transition = advanceAutomatic(state);

    expect(Object.hasOwn(settlement.payouts, '__proto__')).toBe(true);
    expect(settlement.payouts['__proto__']).toBe(50);
    expect(settlement.payouts.p2).toBe(50);
    expect(Object.values(settlement.payouts).reduce((sum, amount) => sum + amount, 0)).toBe(100);
    expect(transition.state.players.map((player) => player.stack)).toEqual([50, 50]);
  });

  it('awards the main and side pots to their independently compared winners', () => {
    const state = handWithMainAndSidePotWinners();
    const settlement = settleShowdown(state);

    expect(settlement.pots).toEqual([
      {
        amount: 300,
        eligiblePlayerIds: ['main-winner', 'side-winner', 'loser'],
        winnerPlayerIds: ['main-winner'],
        payouts: { 'main-winner': 300 },
      },
      {
        amount: 400,
        eligiblePlayerIds: ['side-winner', 'loser'],
        winnerPlayerIds: ['side-winner'],
        payouts: { 'side-winner': 400 },
      },
    ]);
    expect(settlement.payouts).toEqual({
      'main-winner': 300,
      'side-winner': 400,
    });

    const transition = advanceAutomatic(state);
    expect(transition.state.street).toBe('complete');
    expect(transition.state.players.map((player) => player.stack)).toEqual([300, 400, 0]);
  });

  it('settles an automatic showdown and reveals only compared hands', () => {
    const state = handAtShowdown({ dealerIndex: 0, pot: 101, tiedPlayerIds: ['p1', 'p2'] });
    const before = structuredClone(state);
    const transition = advanceAutomatic(state);

    expect(state).toEqual(before);
    expect(transition.state.street).toBe('complete');
    expect(transition.state.players.map((player) => [player.id, player.stack])).toEqual([
      ['p1', 50],
      ['p2', 51],
      ['folded', 0],
    ]);
    expect(transition.events).toHaveLength(1);
    expect(transition.events[0]).toMatchObject({
      type: 'hand-settled',
      settlement: {
        payouts: { p1: 50, p2: 51 },
        revealedPlayerIds: ['p1', 'p2'],
      },
      revealedHands: [
        { playerId: 'p1', cards: state.players[0]!.holeCards },
        { playerId: 'p2', cards: state.players[1]!.holeCards },
      ],
    });
    expect(JSON.stringify(transition.events)).not.toContain('folded');
  });

  it('does not pay a completed showdown twice', () => {
    const state = handAtShowdown({ dealerIndex: 0, pot: 101, tiedPlayerIds: ['p1', 'p2'] });
    const first = advanceAutomatic(state);
    const second = advanceAutomatic(first.state);

    expect(first.state.players.map((player) => player.stack)).toEqual([50, 51, 0]);
    expect(second.state.players.map((player) => player.stack)).toEqual(
      first.state.players.map((player) => player.stack),
    );
    expect(second.events).toEqual([]);
  });
});
