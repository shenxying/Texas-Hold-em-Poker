import { createHand } from '../../src/game/engine';
import type { Room } from '../../src/server/room';

export function roomWithActiveHand(): Room {
  const hand = createHand({
    seats: [
      { id: 'p1', stack: 10_000 },
      { id: 'p2', stack: 10_000 },
    ],
    dealerIndex: 0,
    smallBlind: 50,
    bigBlind: 100,
    randomInt: () => 0,
  });

  return {
    code: 'ABCD23',
    version: 1,
    settings: { startingStack: 10_000, smallBlind: 50, bigBlind: 100 },
    phase: 'playing',
    seats: [
      {
        id: 'p1',
        nickname: '房主',
        seatIndex: 0,
        stack: 10_000,
        connected: true,
        isBot: false,
        joinedOrder: 1,
        sessionToken: 'host-secret',
        connectionId: 'socket-1',
      },
      {
        id: 'p2',
        nickname: '朋友',
        seatIndex: 1,
        stack: 10_000,
        connected: true,
        isBot: false,
        joinedOrder: 2,
        sessionToken: 'guest-secret',
        connectionId: 'socket-2',
      },
      ...Array<null>(7).fill(null),
    ],
    waiting: [],
    hostPlayerId: 'p1',
    hand,
    revealedPlayerIds: new Set(),
    messages: [],
  };
}
