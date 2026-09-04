import { compareHands, evaluateSeven } from './evaluator';
import type { HandPlayer, HandRank, HandState } from './types';

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface SettledPot extends Pot {
  winnerPlayerIds: string[];
  payouts: Record<string, number>;
}

export interface Settlement {
  payouts: Record<string, number>;
  refunds: Record<string, number>;
  pots: SettledPot[];
  revealedPlayerIds: string[];
}

export interface SettlementPotLayout {
  pots: Pot[];
  refunds: Record<string, number>;
}

export function buildPots(players: readonly HandPlayer[]): Pot[] {
  const levels = [...new Set(
    players
      .map((player) => player.totalCommitted)
      .filter((amount) => amount > 0),
  )].sort((a, b) => a - b);

  let previousLevel = 0;
  return levels.map((level) => {
    const contributors = players.filter((player) => player.totalCommitted >= level);
    const pot = {
      amount: (level - previousLevel) * contributors.length,
      eligiblePlayerIds: contributors
        .filter((player) => !player.folded)
        .map((player) => player.id),
    };
    previousLevel = level;
    return pot;
  });
}

function winnersForPot(
  pot: Pot,
  playersById: ReadonlyMap<string, HandPlayer>,
  board: HandState['board'],
): string[] {
  let bestHand: HandRank | null = null;
  const winners: string[] = [];

  for (const playerId of pot.eligiblePlayerIds) {
    const player = playersById.get(playerId)!;
    const hand = evaluateSeven([...player.holeCards, ...board]);
    const comparison = bestHand === null ? 1 : compareHands(hand, bestHand);
    if (comparison > 0) {
      bestHand = hand;
      winners.splice(0, winners.length, playerId);
    } else if (comparison === 0) {
      winners.push(playerId);
    }
  }

  return winners;
}

function winnersLeftOfDealer(state: HandState, winners: readonly string[]): string[] {
  const winnerIds = new Set(winners);
  const ordered: string[] = [];
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const player = state.players[(state.dealerIndex + offset) % state.players.length]!;
    if (winnerIds.has(player.id)) {
      ordered.push(player.id);
    }
  }
  return ordered;
}

function mergeUnclaimedLayers(pots: readonly Pot[]): Pot[] {
  const merged: Pot[] = [];
  let leadingUnclaimed = 0;
  for (const pot of pots) {
    if (pot.eligiblePlayerIds.length === 0) {
      if (merged.length === 0) leadingUnclaimed += pot.amount;
      else merged[merged.length - 1]!.amount += pot.amount;
      continue;
    }
    merged.push({
      amount: pot.amount + leadingUnclaimed,
      eligiblePlayerIds: [...pot.eligiblePlayerIds],
    });
    leadingUnclaimed = 0;
  }
  if (leadingUnclaimed > 0) {
    throw new Error('Cannot settle a pot without an eligible player');
  }
  return merged;
}

export function buildSettlementPotLayout(
  players: readonly HandPlayer[],
): SettlementPotLayout {
  const refunds = new Map<string, number>();
  const commitments = players
    .map((player) => player.totalCommitted)
    .sort((left, right) => right - left);
  const highestCommitment = commitments[0] ?? 0;
  const secondHighestCommitment = commitments[1] ?? 0;
  const highestContributors = players.filter(
    (player) => player.totalCommitted === highestCommitment,
  );
  let potPlayers = players;
  if (highestContributors.length === 1 && highestCommitment > secondHighestCommitment) {
    const contributor = highestContributors[0]!;
    const uncalled = highestCommitment - secondHighestCommitment;
    refunds.set(contributor.id, uncalled);
    potPlayers = players.map((player) => (
      player.id === contributor.id
        ? { ...player, totalCommitted: secondHighestCommitment }
        : player
    ));
  }

  return {
    pots: mergeUnclaimedLayers(buildPots(potPlayers)),
    refunds: Object.fromEntries(refunds),
  };
}

export function settleShowdown(state: HandState): Settlement {
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  const payouts = new Map<string, number>();
  const layout = buildSettlementPotLayout(state.players);

  const pots = layout.pots.map<SettledPot>((pot) => {
    const winnerPlayerIds = winnersForPot(pot, playersById, state.board);
    const share = Math.floor(pot.amount / winnerPlayerIds.length);
    let remainder = pot.amount % winnerPlayerIds.length;
    const potPayouts = new Map<string, number>();

    for (const playerId of winnerPlayerIds) {
      potPayouts.set(playerId, share);
    }
    for (const playerId of winnersLeftOfDealer(state, winnerPlayerIds)) {
      if (remainder === 0) {
        break;
      }
      potPayouts.set(playerId, potPayouts.get(playerId)! + 1);
      remainder -= 1;
    }
    for (const [playerId, amount] of potPayouts) {
      payouts.set(playerId, (payouts.get(playerId) ?? 0) + amount);
    }

    return { ...pot, winnerPlayerIds, payouts: Object.fromEntries(potPayouts) };
  });

  const revealedPlayerIds = state.players
    .filter((player) => !player.folded && player.totalCommitted > 0)
    .map((player) => player.id);
  return {
    payouts: Object.fromEntries(payouts),
    refunds: layout.refunds,
    pots,
    revealedPlayerIds,
  };
}
