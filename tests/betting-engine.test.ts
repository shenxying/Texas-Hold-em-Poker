import { describe, expect, it } from 'vitest';
import {
  advanceAutomatic,
  applyAction,
  createHand,
  forceFold,
  getLegalActions,
} from '../src/game/engine';
import type { HandPlayer, HandState } from '../src/game/types';

const seats = [
  { id: 'p1', stack: 10_000 },
  { id: 'p2', stack: 10_000 },
  { id: 'p3', stack: 10_000 },
];

function expectErrorCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

function actedPlayer(
  id: string,
  stack: number,
  lastFacedBet: number | null = 100,
): HandPlayer {
  return {
    id,
    stack,
    holeCards: [],
    streetBet: 100,
    totalCommitted: 100,
    folded: false,
    allIn: false,
    actedSinceFullRaise: lastFacedBet !== null,
    lastFacedBet,
    lastAction: 'call',
  };
}

function cumulativeRaiseState(firstStack: number, secondStack: number): HandState {
  return {
    players: [
      actedPlayer('p1', 900),
      actedPlayer('p2', firstStack, null),
      actedPlayer('p3', secondStack, null),
      actedPlayer('p4', 900),
    ],
    street: 'flop',
    currentBet: 100,
    lastFullRaiseSize: 100,
    actorId: 'p2',
    dealerIndex: 0,
    board: [],
    deck: [],
    smallBlind: 50,
    bigBlind: 100,
  };
}

function totalChips(state: HandState): number {
  return state.players.reduce(
    (total, player) => total + player.stack + player.totalCommitted,
    0,
  );
}

describe('betting engine', () => {
  it('posts blinds and starts preflop left of the big blind', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expect(state.players.map((player) => player.streetBet)).toEqual([0, 50, 100]);
    expect(state.actorId).toBe('p1');
    expect(getLegalActions(state, 'p1')).toMatchObject({ callAmount: 100, minRaiseTo: 200 });
  });

  it('lets the big blind raise to the legal minimum after every caller matches', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;

    expect(getLegalActions(state, 'p3')).toMatchObject({
      canCheck: true,
      canRaise: true,
      minRaiseTo: 200,
      maxRaiseTo: 10_000,
    });
  });

  it('moves to the flop only after every active player has matched and acted', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    expect(state.street).toBe('flop');
    expect(state.board).toHaveLength(3);
    expect(state.actorId).toBe('p2');
  });

  it('does not reopen raising after an incomplete all-in raise', () => {
    const shortSeats = [
      { id: 'p1', stack: 10_000 },
      { id: 'p2', stack: 150 },
      { id: 'p3', stack: 10_000 },
    ];
    let state = createHand({
      seats: shortSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'call' }).state;
    expect(getLegalActions(state, 'p1')).toMatchObject({
      canRaise: false,
      canAllIn: false,
    });
  });

  it('reopens raising when consecutive short all-ins cumulatively equal a full raise', () => {
    let state = cumulativeRaiseState(50, 100);
    const chips = totalChips(state);

    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'all-in' }).state;

    expect(state.actorId).toBe('p4');
    expect(getLegalActions(state, 'p4')).toMatchObject({
      canRaise: true,
      canAllIn: true,
      minRaiseTo: 300,
    });

    state = applyAction(state, { playerId: 'p4', type: 'call' }).state;

    expect(state.actorId).toBe('p1');
    expect(getLegalActions(state, 'p1')).toMatchObject({
      canRaise: true,
      canAllIn: true,
      minRaiseTo: 300,
      maxRaiseTo: 1_000,
    });
    expect(totalChips(state)).toBe(chips);
  });

  it('keeps raising closed when consecutive short all-ins remain below a full raise', () => {
    let state = cumulativeRaiseState(40, 90);
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p4', type: 'call' }).state;

    expect(state.currentBet).toBe(190);
    expect(getLegalActions(state, 'p1')).toMatchObject({
      canRaise: false,
      canAllIn: false,
    });
  });

  it('measures reopening from the wager a player most recently faced', () => {
    const state = cumulativeRaiseState(50, 100);
    state.currentBet = 200;
    state.actorId = 'p4';
    state.players[3] = actedPlayer('p4', 860, 140);
    state.players[3]!.streetBet = 140;
    state.players[3]!.totalCommitted = 140;

    expect(getLegalActions(state, 'p4')).toMatchObject({
      callAmount: 60,
      canRaise: false,
      canAllIn: false,
    });
  });

  it('awards the pot and completes the hand when everyone but one player folds', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'fold' }).state;
    const transition = applyAction(state, { playerId: 'p2', type: 'fold' });

    expect(transition.state.street).toBe('complete');
    expect(transition.state.actorId).toBeNull();
    expect(transition.state.players.find((player) => player.id === 'p3')!.stack).toBe(10_050);
    expect(transition.events).toContainEqual({
      type: 'uncontested-awarded',
      playerId: 'p3',
      amount: 150,
    });
  });

  it('runs out and settles the complete board when all remaining players are all-in', () => {
    const allInSeats = seats.map((seat) => ({ ...seat, stack: 100 }));
    let state = createHand({
      seats: allInSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
      randomInt: () => 0,
    });
    state = applyAction(state, { playerId: 'p1', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;

    expect(state.street).toBe('complete');
    expect(state.board).toHaveLength(5);
    expect(state.actorId).toBeNull();
  });

  it('settles blind-created heads-up all-in state without exposing a dry-side-pot action', () => {
    const state = createHand({
      seats: [
        { id: 'p1', stack: 50 },
        { id: 'p2', stack: 10_000 },
      ],
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
      randomInt: () => 0,
    });

    expect(state.street).toBe('complete');
    expect(state.board).toHaveLength(5);
    expect(state.actorId).toBeNull();
    expect(getLegalActions(state, 'p2')).toMatchObject({
      canRaise: false,
      canAllIn: false,
    });
  });

  it('settles a multi-player hand when actions leave one matched non-all-in player', () => {
    let state = createHand({
      seats: [
        { id: 'p1', stack: 100 },
        { id: 'p2', stack: 100 },
        { id: 'p3', stack: 10_000 },
      ],
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
      randomInt: () => 0,
    });
    state = applyAction(state, { playerId: 'p1', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;

    expect(state.street).toBe('complete');
    expect(state.board).toHaveLength(5);
    expect(state.actorId).toBeNull();
    expect(getLegalActions(state, 'p3')).toMatchObject({
      canRaise: false,
      canAllIn: false,
    });
  });

  it('runs out and settles when only one non-all-in player remains and no call is owed', () => {
    const headsUpSeats = [
      { id: 'p1', stack: 100 },
      { id: 'p2', stack: 10_000 },
    ];
    let state = createHand({
      seats: headsUpSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
      randomInt: () => 0,
    });
    state = applyAction(state, { playerId: 'p1', type: 'all-in' }).state;

    expect(state.street).toBe('complete');
    expect(state.board).toHaveLength(5);
    expect(state.actorId).toBeNull();
  });

  it('posts only a short player stack when it is less than the blind', () => {
    const shortBlindSeats = [seats[0]!, { id: 'p2', stack: 30 }, seats[2]!];
    const state = createHand({
      seats: shortBlindSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    const shortBlind = state.players[1]!;

    expect(shortBlind).toMatchObject({
      stack: 0,
      streetBet: 30,
      totalCommitted: 30,
      allIn: true,
    });
  });

  it('keeps the full big blind as the preflop bring-in when the big blind is short', () => {
    const shortBigBlindSeats = [seats[0]!, seats[1]!, { id: 'p3', stack: 30 }];
    const state = createHand({
      seats: shortBigBlindSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });

    expect(state.players[2]).toMatchObject({ stack: 0, streetBet: 30, allIn: true });
    expect(state.currentBet).toBe(100);
    expect(getLegalActions(state, 'p1').callAmount).toBe(100);
  });

  it('uses the big blind as the minimum postflop opening bet', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;

    expect(getLegalActions(state, 'p2')).toMatchObject({
      canBet: true,
      minRaiseTo: 100,
    });
  });

  it('allows a short postflop all-in opening to be completed to the big blind', () => {
    const shortOpenerSeats = [
      { id: 'p1', stack: 10_000 },
      { id: 'p2', stack: 180 },
      { id: 'p3', stack: 10_000 },
      { id: 'p4', stack: 10_000 },
    ];
    let state = createHand({
      seats: shortOpenerSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    state = applyAction(state, { playerId: 'p4', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;

    expect(getLegalActions(state, 'p3')).toMatchObject({
      callAmount: 80,
      canRaise: true,
      minRaiseTo: 100,
    });
    state = applyAction(state, { playerId: 'p3', type: 'raise', amount: 100 }).state;
    expect(state.lastFullRaiseSize).toBe(100);
  });

  it('reopens checked action when an all-in completes a short opening to the big blind', () => {
    const completionSeats = [
      { id: 'p1', stack: 10_000 },
      { id: 'p2', stack: 10_000 },
      { id: 'p3', stack: 180 },
      { id: 'p4', stack: 200 },
      { id: 'p5', stack: 10_000 },
    ];
    let state = createHand({
      seats: completionSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    for (const playerId of ['p4', 'p5', 'p1', 'p2'] as const) {
      state = applyAction(state, { playerId, type: 'call' }).state;
    }
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'check' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p4', type: 'all-in' }).state;

    expect(state.currentBet).toBe(100);
    expect(state.lastFullRaiseSize).toBe(100);
    expect(state.players[1]!.actedSinceFullRaise).toBe(false);
  });

  it('reopens action after a full raise', () => {
    const raisingSeats = [seats[0]!, { id: 'p2', stack: 250 }, seats[2]!];
    let state = createHand({
      seats: raisingSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'call' }).state;

    expect(getLegalActions(state, 'p1')).toMatchObject({
      canRaise: true,
      minRaiseTo: 400,
    });
  });

  it('skips folded and all-in seats when choosing the next actor', () => {
    const orderSeats = [
      { id: 'p1', stack: 10_000 },
      { id: 'p2', stack: 50 },
      { id: 'p3', stack: 10_000 },
      { id: 'p4', stack: 10_000 },
    ];
    let state = createHand({
      seats: orderSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    state = applyAction(state, { playerId: 'p4', type: 'fold' }).state;
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    expect(state.actorId).toBe('p3');

    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    expect(state.street).toBe('flop');
    expect(state.actorId).toBe('p3');

    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    expect(state.actorId).toBe('p1');
  });

  it('uses heads-up blind and action order before and after the flop', () => {
    const headsUpSeats = seats.slice(0, 2);
    let state = createHand({
      seats: headsUpSeats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
    });
    expect(state.players.map((player) => player.streetBet)).toEqual([50, 100]);
    expect(state.actorId).toBe('p1');

    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'check' }).state;
    expect(state.street).toBe('flop');
    expect(state.actorId).toBe('p2');
  });

  it('rejects actions from the wrong player with a stable code', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expectErrorCode(
      () => applyAction(state, { playerId: 'p2', type: 'call' }),
      'NOT_PLAYER_TURN',
    );
  });

  it.each([-1, 1.5])('rejects the invalid raise amount %s with a stable code', (amount) => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expectErrorCode(
      () => applyAction(state, { playerId: 'p1', type: 'raise', amount }),
      'INVALID_AMOUNT',
    );
  });

  it.each([150, 10_001])('rejects the out-of-range raise-to amount %s', (amount) => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expectErrorCode(
      () => applyAction(state, { playerId: 'p1', type: 'raise', amount }),
      'AMOUNT_OUT_OF_RANGE',
    );
  });

  it('rejects checks facing a bet and calls without a bet', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expectErrorCode(
      () => applyAction(state, { playerId: 'p1', type: 'check' }),
      'ILLEGAL_ACTION',
    );

    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    expectErrorCode(
      () => applyAction(state, { playerId: 'p2', type: 'call' }),
      'ILLEGAL_ACTION',
    );
  });

  it('returns immutable transition snapshots', () => {
    const state = createHand({
      seats,
      dealerIndex: 0,
      smallBlind: 50,
      bigBlind: 100,
      randomInt: () => 0,
    });
    const before = structuredClone(state);
    const transition = applyAction(state, { playerId: 'p1', type: 'call' });

    expect(state).toEqual(before);
    expect(transition.state).not.toBe(state);
    expect(transition.state.players).not.toBe(state.players);
    expect(transition.state.players[0]!.holeCards[0]).not.toBe(state.players[0]!.holeCards[0]);
  });


  it('does not choose a player action during automatic progression', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const transition = advanceAutomatic(state);

    expect(transition.events).toEqual([]);
    expect(transition.state).toEqual(state);
    expect(transition.state).not.toBe(state);
  });

  it('force-folds a non-actor without changing the current actor', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const leaving = state.players.find((player) => player.id !== state.actorId)!.id;
    const transition = forceFold(state, leaving);
    expect(transition.state.players.find((player) => player.id === leaving)).toMatchObject({ folded: true, lastAction: 'fold' });
    expect(transition.state.actorId).toBe(state.actorId);
    expect(state.players.find((player) => player.id === leaving)!.folded).toBe(false);
  });

  it('force-folds the actor and advances to the next eligible player', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const transition = forceFold(state, state.actorId!);
    expect(transition.state.actorId).not.toBe(state.actorId);
    expect(transition.events).toContainEqual({ type: 'player-acted', action: { playerId: state.actorId, type: 'fold' } });
  });

  it('awards an uncontested pot when a forced fold leaves one player', () => {
    const state = createHand({ seats: seats.slice(0, 2), dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const transition = forceFold(state, state.actorId!);
    expect(transition.state.street).toBe('complete');
    expect(transition.state.actorId).toBeNull();
    expect(transition.events).toContainEqual({ type: 'uncontested-awarded', playerId: 'p2', amount: 150 });
  });

  it('rejects an unknown forced-fold player', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expectErrorCode(() => forceFold(state, 'missing'), 'UNKNOWN_PLAYER');
  });

  it('makes forced folding of an already-folded player idempotent', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const folded = forceFold(state, 'p2').state;
    const transition = forceFold(folded, 'p2');
    expect(transition.events).toEqual([]);
    expect(transition.state).toEqual(folded);
  });

  it('allows an all-in player to forfeit the hand on forced fold', () => {
    const state = createHand({ seats: [{ id: 'p1', stack: 50 }, { id: 'p2', stack: 30 }, { id: 'p3', stack: 10_000 }], dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    const transition = forceFold(state, 'p2');
    expect(transition.state.players.find((player) => player.id === 'p2')).toMatchObject({ folded: true, allIn: true });
    expect(transition.state.actorId).toBe('p1');
    expect(transition.state.street).toBe('preflop');
  });
});
