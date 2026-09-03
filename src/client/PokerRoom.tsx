import { useState } from 'react';
import type { ClientPlayerAction, TableView } from '../shared/protocol';
import { ActionBar } from './ActionBar';
import { ChatPanel } from './ChatPanel';
import { PokerTable } from './PokerTable';
import type { PokerClient } from './socket';

interface PokerRoomProps {
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  notice?: string;
  onError?: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export function PokerRoom({
  client,
  view,
  playerId,
  connected,
  notice = '',
  onError = () => {},
}: PokerRoomProps): React.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const me = view.players.find((player) => player.id === playerId);
  const potTotal = view.pots.reduce((total, pot) => total + pot.amount, 0);
  const canStart = me?.isHost === true && view.phase !== 'playing' && view.players.length >= 2;

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

  function sendChat(text: string): Promise<unknown> {
    return client.send('chat:send', { text }).catch((error: unknown) => {
      onError(errorText(error));
      throw error;
    });
  }

  return (
    <section className="poker-room" aria-label="私人德州房间">
      <div className="live-notices">
        {!connected && <p aria-live="polite">连接已断开，操作和聊天暂不可用</p>}
        {view.waitingPosition !== undefined && (
          <p aria-live="polite">当前等待位置：{view.waitingPosition}</p>
        )}
        {notice !== '' && <p aria-live="polite">{notice}</p>}
      </div>

      <PokerTable view={view} playerId={playerId} />

      {canStart && (
        <button type="button" className="start-game" disabled={!connected || startPending}
          onClick={() => void startGame()}>
          {startPending ? '开始中…' : view.phase === 'between-hands' ? '开始下一手' : '开始游戏'}
        </button>
      )}

      {view.actorId === playerId && view.legalActions !== undefined && (
        <aside className={`action-drawer${actionsOpen ? ' open' : ' closed'}`}>
          <button
            className="drawer-toggle action-toggle"
            type="button"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((open) => !open)}
          >
            {actionsOpen ? '收起操作区' : '展开操作区'}
          </button>
          <div className="action-drawer-content">
            <ActionBar
              legalActions={view.legalActions}
              potTotal={potTotal}
              streetBet={me?.streetBet ?? 0}
              deadline={view.actionDeadline}
              disabled={!connected}
              onAct={act}
            />
          </div>
        </aside>
      )}

      <button
        className="drawer-toggle chat-toggle"
        type="button"
        aria-expanded={chatOpen}
        onClick={() => setChatOpen((open) => !open)}
      >
        {chatOpen ? '关闭聊天' : '打开聊天'}
      </button>
      <aside
        className={`chat-drawer${chatOpen ? ' open' : ''}`}
        {...(chatOpen ? { role: 'dialog' as const, 'aria-label': '房间聊天' } : {})}
      >
        <ChatPanel
          messages={view.messages}
          disabled={!connected}
          onSend={sendChat}
        />
      </aside>
    </section>
  );
}
