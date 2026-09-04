import { useEffect, useState } from 'react';
import type { TableView } from '../shared/protocol';
import { PlayerDock } from './PlayerDock';
import { PokerTable } from './PokerTable';
import { RoomHeader } from './RoomHeader';
import { RoomSidePanel, type RoomPanelTab } from './RoomSidePanel';
import type { PokerClient } from './socket';

interface PokerRoomProps {
  client: PokerClient;
  view?: TableView;
  roomCode?: string;
  playerId: string;
  inviteUrl: string;
  connected: boolean;
  leaving: boolean;
  notice?: string;
  onLeave: () => Promise<void>;
  onError: (message: string) => void;
}

export function PokerRoom({
  client,
  view,
  roomCode,
  playerId,
  inviteUrl,
  connected,
  leaving,
  notice = '',
  onLeave,
  onError,
}: PokerRoomProps): React.JSX.Element {
  const [openTab, setOpenTab] = useState<RoomPanelTab | null>(null);
  const [chatRevealVersion, setChatRevealVersion] = useState(0);
  const me = view?.players.find((player) => player.id === playerId);
  const isHost = me?.isHost === true;
  const resolvedRoomCode = view?.roomCode ?? roomCode ?? '';

  useEffect(() => {
    if (!isHost && openTab === 'settings') {
      setOpenTab(null);
      queueMicrotask(() => document.getElementById('room-open-chat')?.focus());
    }
  }, [isHost, openTab]);

  function selectPanel(tab: RoomPanelTab): void {
    if (tab === 'settings' && !isHost) return;
    if (tab === 'chat' && openTab !== 'chat') {
      setChatRevealVersion((version) => version + 1);
    }
    setOpenTab(tab);
  }

  function closePanel(): void {
    const triggerId = openTab === null ? undefined : `room-open-${openTab}`;
    setOpenTab(null);
    if (triggerId !== undefined) {
      queueMicrotask(() => document.getElementById(triggerId)?.focus());
    }
  }

  return (
    <section className="poker-room room-cockpit" aria-label="私人德州房间">
      <RoomHeader
        roomCode={resolvedRoomCode}
        inviteUrl={inviteUrl}
        connected={connected}
        playing={view === undefined || view.phase === 'playing'}
        leaving={leaving}
        isHost={isHost}
        openTab={openTab}
        panelAvailable={view !== undefined}
        onOpenPanel={selectPanel}
        onLeave={onLeave}
      />

      {view === undefined ? (
        <div className="table-loading" aria-live="polite">正在同步牌桌…</div>
      ) : (
        <>
          <div className="cockpit-body" data-panel-open={openTab !== null}>
            <div className="table-stage">
              <div className="live-notices">
                {!connected && <p aria-live="polite">连接已断开，操作和聊天暂不可用</p>}
                {view.waitingPosition !== undefined && (
                  <p aria-live="polite">当前等待位置：{view.waitingPosition}</p>
                )}
                {notice !== '' && <p aria-live="polite">{notice}</p>}
              </div>
              <PokerTable view={view} playerId={playerId} />
            </div>

            <RoomSidePanel
              openTab={openTab}
              client={client}
              view={view}
              playerId={playerId}
              connected={connected}
              chatRevealVersion={chatRevealVersion}
              onClose={closePanel}
              onSelect={selectPanel}
              onError={onError}
            />
          </div>

          <PlayerDock
            client={client}
            view={view}
            playerId={playerId}
            connected={connected}
            onError={onError}
          />
        </>
      )}
    </section>
  );
}
