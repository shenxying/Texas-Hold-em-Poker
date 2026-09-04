import { useState } from 'react';
import type { ClientPlayerAction, TableView } from '../shared/protocol';
import { ActionBar } from './ActionBar';
import { PlayingCard } from './PlayingCard';
import type { PokerClient } from './socket';

interface PlayerDockProps {
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  onError: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export function PlayerDock({
  client,
  view,
  playerId,
  connected,
  onError,
}: PlayerDockProps): React.JSX.Element {
  const [startPending, setStartPending] = useState(false);
  const me = view.players.find((player) => player.id === playerId);
  const potTotal = view.pots.reduce((total, pot) => total + pot.amount, 0);
  const canStart = me?.isHost === true && view.phase !== 'playing' &&
    view.players.filter((player) => player.stack > 0).length >= 2;

  async function report(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      onError(errorText(error));
    }
  }

  async function startGame(): Promise<void> {
    setStartPending(true);
    try {
      await report(() => client.send('game:start', {}));
    } finally {
      setStartPending(false);
    }
  }

  function act(action: ClientPlayerAction): Promise<unknown> {
    return report(() => client.send('game:act', action));
  }

  const turnText = view.actorId === playerId
    ? '轮到你行动'
    : view.phase === 'playing'
      ? '等待其他玩家行动'
      : view.phase === 'between-hands'
        ? '本手已结束'
        : '等待开局';

  return (
    <section className="player-dock" role="region" aria-label="我的手牌和操作">
      <div className="player-dock-identity">
        <strong>{me?.nickname ?? '等待入座'}</strong>
        <span>筹码 {me?.stack ?? 0}</span>
        <span className="turn-context">{turnText}</span>
      </div>

      <div className="player-dock-cards" aria-label="我的手牌">
        {me?.holeCards === undefined ? (
          <span className="hand-placeholder">等待发牌</span>
        ) : me.holeCards.map((card, index) => <PlayingCard key={index} card={card} />)}
      </div>

      <div className="player-dock-actions">
        {canStart && (
          <button
            type="button"
            className="start-game"
            disabled={!connected || startPending}
            onClick={() => void startGame()}
          >
            {startPending ? '开始中…' : view.phase === 'between-hands' ? '开始下一手' : '开始游戏'}
          </button>
        )}
        {view.actorId === playerId && view.legalActions !== undefined && (
          <ActionBar
            legalActions={view.legalActions}
            potTotal={potTotal}
            streetBet={me?.streetBet ?? 0}
            deadline={view.actionDeadline}
            disabled={!connected}
            onAct={act}
          />
        )}
      </div>
    </section>
  );
}
