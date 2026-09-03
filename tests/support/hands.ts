import { parseCard } from '../../src/game/cards';
import type { HandPlayer, HandState } from '../../src/game/types';

interface ShowdownOptions {
  dealerIndex: number;
  pot: number;
  tiedPlayerIds: readonly string[];
}

const HOLE_CARDS = ['2c 3d', '4c 5d', '6c 7d', '8c 9d', 'Tc Jd', 'Qc Kd'];

function player(id: string, totalCommitted: number, holeCards: string): HandPlayer {
  return {
    id,
    stack: 0,
    holeCards: holeCards.split(' ').map(parseCard),
    streetBet: 0,
    totalCommitted,
    folded: false,
    allIn: true,
    actedSinceFullRaise: true,
    lastFacedBet: 0,
    lastAction: 'all-in',
  };
}

export function handAtShowdown(options: ShowdownOptions): HandState {
  const contribution = Math.floor(options.pot / options.tiedPlayerIds.length);
  const players = options.tiedPlayerIds.map((id, index) =>
    player(id, contribution, HOLE_CARDS[index]!),
  );
  const deadChips = options.pot - contribution * players.length;
  if (deadChips > 0) {
    players.push({
      ...player('folded', deadChips, 'Ac Ad'),
      folded: true,
      allIn: false,
      lastAction: 'fold',
    });
  }

  return {
    players,
    street: 'showdown',
    currentBet: 0,
    lastFullRaiseSize: 2,
    actorId: null,
    dealerIndex: options.dealerIndex,
    board: 'As Ks Qs Js Ts'.split(' ').map(parseCard),
    deck: [],
    smallBlind: 1,
    bigBlind: 2,
  };
}

export function handWithMainAndSidePotWinners(): HandState {
  return {
    players: [
      player('main-winner', 100, '5s 6s'),
      player('side-winner', 300, 'Kh Kd'),
      player('loser', 300, 'Ah Ad'),
    ],
    street: 'showdown',
    currentBet: 0,
    lastFullRaiseSize: 2,
    actorId: null,
    dealerIndex: 0,
    board: '2c 3d 4h 9s Kc'.split(' ').map(parseCard),
    deck: [],
    smallBlind: 1,
    bigBlind: 2,
  };
}
