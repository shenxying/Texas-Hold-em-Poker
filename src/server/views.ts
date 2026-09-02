import { getLegalActions } from '../game/engine';
import { buildPots } from '../game/pots';
import type { Card } from '../game/types';
import type { PublicPlayer, TableView } from '../shared/protocol';
import type { Room, RoomPlayer } from './room';

function cloneCards(cards: readonly Card[]): Card[] {
  return cards.map((card) => ({ ...card }));
}

function publicPlayer(room: Room, player: RoomPlayer, viewerPlayerId: string): PublicPlayer {
  const handPlayer = room.hand?.players.find((candidate) => candidate.id === player.id);
  const mayReveal =
    handPlayer !== undefined &&
    (player.id === viewerPlayerId || room.revealedPlayerIds.has(player.id));
  return {
    id: player.id,
    nickname: player.nickname,
    seatIndex: player.seatIndex!,
    stack: handPlayer?.stack ?? player.stack,
    streetBet: handPlayer?.streetBet ?? 0,
    connected: player.connected,
    isBot: player.isBot,
    ...(player.botStyle === undefined ? {} : { botStyle: player.botStyle }),
    isHost: room.hostPlayerId === player.id,
    folded: handPlayer?.folded ?? false,
    allIn: handPlayer?.allIn ?? false,
    ...(handPlayer?.lastAction ? { lastAction: handPlayer.lastAction } : {}),
    holeCardCount: handPlayer?.holeCards.length ?? 0,
    ...(mayReveal ? { holeCards: cloneCards(handPlayer.holeCards) } : {}),
  };
}

export function createTableView(room: Room, viewerPlayerId: string): TableView {
  const hand = room.hand;
  const players = room.seats
    .filter((player): player is RoomPlayer => player !== null)
    .map((player) => publicPlayer(room, player, viewerPlayerId));
  const dealerId = hand?.players[hand.dealerIndex]?.id;
  const dealerSeatIndex = dealerId === undefined
    ? undefined
    : players.find((player) => player.id === dealerId)?.seatIndex;
  const viewerWaitingIndex = room.waiting.findIndex((player) => player.id === viewerPlayerId);
  const legalActions = hand?.actorId === viewerPlayerId
    ? getLegalActions(hand, viewerPlayerId)
    : undefined;

  return {
    version: room.version,
    roomCode: room.code,
    settings: { ...room.settings },
    phase: room.phase,
    players,
    board: cloneCards(hand?.board ?? []),
    pots: hand === undefined ? [] : buildPots(hand.players).map((pot) => ({ amount: pot.amount })),
    ...(hand?.actorId ? { actorId: hand.actorId } : {}),
    ...(dealerSeatIndex === undefined ? {} : { dealerSeatIndex }),
    ...(legalActions === undefined ? {} : { legalActions }),
    ...(room.actionDeadline === undefined ? {} : { actionDeadline: room.actionDeadline }),
    ...(viewerWaitingIndex === -1 ? {} : { waitingPosition: viewerWaitingIndex + 1 }),
    messages: room.messages.map((message) => ({
      ...message,
      ...(message.sender === undefined ? {} : { sender: { ...message.sender } }),
    })),
  };
}
