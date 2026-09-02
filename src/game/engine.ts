import { applyBettingAction, GameRuleError, getLegalActions } from './betting';
import { createDeck, shuffleDeck } from './cards';
import type {
  Card,
  GameEvent,
  HandConfig,
  HandPlayer,
  HandState,
  HandTransition,
  PlayerAction,
  Street,
} from './types';

export { GameRuleError, getLegalActions } from './betting';
export type {
  GameEvent,
  HandConfig,
  HandPlayer,
  HandState,
  HandTransition,
  LegalActions,
  PlayerAction,
  Street,
} from './types';

function cloneCards(cards: readonly Card[]): Card[] {
  return cards.map((card) => ({ ...card }));
}

function cloneState(state: HandState): HandState {
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      holeCards: cloneCards(player.holeCards),
    })),
    board: cloneCards(state.board),
    deck: cloneCards(state.deck),
  };
}

function validateConfig(config: HandConfig): void {
  const validSeats =
    config.seats.length >= 2 &&
    config.seats.length <= 9 &&
    new Set(config.seats.map((seat) => seat.id)).size === config.seats.length &&
    config.seats.every(
      (seat) => seat.id.length > 0 && Number.isInteger(seat.stack) && seat.stack > 0,
    );
  const validBlinds =
    Number.isInteger(config.smallBlind) &&
    Number.isInteger(config.bigBlind) &&
    config.smallBlind > 0 &&
    config.bigBlind >= config.smallBlind;
  const validDealer =
    Number.isInteger(config.dealerIndex) &&
    config.dealerIndex >= 0 &&
    config.dealerIndex < config.seats.length;

  if (!validSeats || !validBlinds || !validDealer) {
    throw new GameRuleError('INVALID_HAND_CONFIG', 'Invalid hand configuration');
  }
}

function nextIndex(players: readonly HandPlayer[], index: number): number {
  return (index + 1) % players.length;
}

function findNextActorIndex(state: HandState, startIndex: number): number | null {
  let index = startIndex;
  for (let count = 0; count < state.players.length; count += 1) {
    const player = state.players[index]!;
    if (!player.folded && !player.allIn) {
      return index;
    }
    index = nextIndex(state.players, index);
  }
  return null;
}

function actorIndex(state: HandState): number | null {
  if (state.actorId === null) {
    return null;
  }
  const index = state.players.findIndex((player) => player.id === state.actorId);
  return index === -1 ? null : index;
}

function postBlind(player: HandPlayer, requestedAmount: number): void {
  const amount = Math.min(player.stack, requestedAmount);
  player.stack -= amount;
  player.streetBet += amount;
  player.totalCommitted += amount;
  player.allIn = player.stack === 0;
}

function dealHoleCards(players: HandPlayer[], deck: Card[], dealerIndex: number): void {
  let seatIndex = nextIndex(players, dealerIndex);
  for (let round = 0; round < 2; round += 1) {
    for (let count = 0; count < players.length; count += 1) {
      players[seatIndex]!.holeCards.push(deck.shift()!);
      seatIndex = nextIndex(players, seatIndex);
    }
  }
}

function blindIndexes(playerCount: number, dealerIndex: number): [number, number] {
  if (playerCount === 2) {
    return [dealerIndex, (dealerIndex + 1) % playerCount];
  }
  const smallBlindIndex = (dealerIndex + 1) % playerCount;
  return [smallBlindIndex, (smallBlindIndex + 1) % playerCount];
}

export function createHand(config: HandConfig): HandState {
  validateConfig(config);
  const randomInt = config.randomInt ?? ((max: number) => Math.floor(Math.random() * max));
  const deck = shuffleDeck(createDeck(), randomInt);
  const players = config.seats.map<HandPlayer>((seat) => ({
    id: seat.id,
    stack: seat.stack,
    holeCards: [],
    streetBet: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    actedSinceFullRaise: false,
    lastAction: null,
  }));
  dealHoleCards(players, deck, config.dealerIndex);

  const [smallBlindIndex, bigBlindIndex] = blindIndexes(players.length, config.dealerIndex);
  postBlind(players[smallBlindIndex]!, config.smallBlind);
  postBlind(players[bigBlindIndex]!, config.bigBlind);
  const currentBet = config.bigBlind;
  const partialState: HandState = {
    players,
    street: 'preflop',
    currentBet,
    lastFullRaiseSize: config.bigBlind,
    actorId: null,
    dealerIndex: config.dealerIndex,
    board: [],
    deck,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
  };
  const firstActorStart = players.length === 2
    ? config.dealerIndex
    : nextIndex(players, bigBlindIndex);
  const firstActorIndex = findNextActorIndex(partialState, firstActorStart);
  partialState.actorId = firstActorIndex === null ? null : players[firstActorIndex]!.id;
  return partialState;
}

function nonFoldedPlayers(state: HandState): HandPlayer[] {
  return state.players.filter((player) => !player.folded);
}

function roundClosed(state: HandState): boolean {
  const playersWhoCanAct = state.players.filter((player) => !player.folded && !player.allIn);
  const everyBetMatched = playersWhoCanAct.every(
    (player) => player.streetBet === state.currentBet,
  );
  return everyBetMatched && (
    playersWhoCanAct.length <= 1 ||
    playersWhoCanAct.every((player) => player.actedSinceFullRaise)
  );
}

function nextStreet(street: Street): Exclude<Street, 'preflop' | 'complete'> {
  switch (street) {
    case 'preflop':
      return 'flop';
    case 'flop':
      return 'turn';
    case 'turn':
      return 'river';
    case 'river':
    case 'showdown':
    case 'complete':
      return 'showdown';
  }
}

function advanceStreet(state: HandState, events: GameEvent[]): void {
  const street = nextStreet(state.street);
  const cardCount = street === 'flop' ? 3 : street === 'showdown' ? 0 : 1;
  const cards = state.deck.splice(0, cardCount);
  state.board.push(...cards);
  state.street = street;
  state.currentBet = 0;
  state.lastFullRaiseSize = state.bigBlind;
  for (const player of state.players) {
    player.streetBet = 0;
    player.actedSinceFullRaise = false;
    player.lastAction = null;
  }
  events.push({ type: 'street-advanced', street, cards: cloneCards(cards) });

  if (street === 'showdown') {
    state.actorId = null;
    return;
  }

  const start = nextIndex(state.players, state.dealerIndex);
  const firstActor = findNextActorIndex(state, start);
  state.actorId = firstActor === null ? null : state.players[firstActor]!.id;
}

function awardUncontested(state: HandState, events: GameEvent[]): void {
  const winner = nonFoldedPlayers(state)[0]!;
  const amount = state.players.reduce((sum, player) => sum + player.totalCommitted, 0);
  winner.stack += amount;
  state.street = 'complete';
  state.actorId = null;
  events.push({ type: 'uncontested-awarded', playerId: winner.id, amount });
}

export function advanceAutomatic(input: HandState): HandTransition {
  const state = cloneState(input);
  const events: GameEvent[] = [];

  while (state.street !== 'showdown' && state.street !== 'complete') {
    if (nonFoldedPlayers(state).length === 1) {
      awardUncontested(state, events);
      break;
    }
    if (!roundClosed(state)) {
      break;
    }
    advanceStreet(state, events);
  }

  return { state, events };
}

export function applyAction(input: HandState, action: PlayerAction): HandTransition {
  const state = cloneState(input);
  const currentActorIndex = actorIndex(state);
  applyBettingAction(state, action);
  const events: GameEvent[] = [{ type: 'player-acted', action: { ...action } }];

  if (nonFoldedPlayers(state).length > 1 && !roundClosed(state)) {
    const start = currentActorIndex === null ? 0 : nextIndex(state.players, currentActorIndex);
    const nextActor = findNextActorIndex(state, start);
    state.actorId = nextActor === null ? null : state.players[nextActor]!.id;
  } else {
    state.actorId = null;
  }

  const automatic = advanceAutomatic(state);
  return { state: automatic.state, events: [...events, ...automatic.events] };
}
