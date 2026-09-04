import type { KeyboardEvent } from 'react';
import type { TableView } from '../shared/protocol';
import { ChatPanel } from './ChatPanel';
import { RoomControls } from './RoomControls';
import type { PokerClient } from './socket';

export type RoomPanelTab = 'chat' | 'settings';

interface RoomSidePanelProps {
  openTab: RoomPanelTab | null;
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  chatRevealVersion: number;
  onClose: () => void;
  onSelect: (tab: RoomPanelTab) => void;
  onError: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export function RoomSidePanel({
  openTab,
  client,
  view,
  playerId,
  connected,
  chatRevealVersion,
  onClose,
  onSelect,
  onError,
}: RoomSidePanelProps): React.JSX.Element {
  const isHost = view.players.some((player) => player.id === playerId && player.isHost);
  const tabs: RoomPanelTab[] = isHost ? ['chat', 'settings'] : ['chat'];

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, current: RoomPanelTab): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const currentIndex = tabs.indexOf(current);
    const next = tabs[(currentIndex + offset + tabs.length) % tabs.length]!;
    onSelect(next);
    document.getElementById(`room-tab-${next}`)?.focus();
  }

  function sendChat(text: string): Promise<unknown> {
    return client.send('chat:send', { text }).catch((error: unknown) => {
      onError(errorText(error));
      throw error;
    });
  }

  return (
    <aside
      id="room-side-panel"
      className={`room-side-panel${openTab === null ? ' closed' : ' open'}`}
      aria-label="房间侧边栏"
      data-testid="room-side-panel"
      hidden={openTab === null}
    >
      <div className="side-panel-header">
        <div role="tablist" aria-label="房间面板">
          <button
            id="room-tab-chat"
            type="button"
            role="tab"
            aria-selected={openTab === 'chat'}
            aria-controls="room-panel-chat"
            tabIndex={openTab === 'chat' ? 0 : -1}
            onKeyDown={(event) => handleTabKey(event, 'chat')}
            onClick={() => onSelect('chat')}
          >
            聊天
          </button>
          {isHost && (
            <button
              id="room-tab-settings"
              type="button"
              role="tab"
              aria-selected={openTab === 'settings'}
              aria-controls="room-panel-settings"
              tabIndex={openTab === 'settings' ? 0 : -1}
              onKeyDown={(event) => handleTabKey(event, 'settings')}
              onClick={() => onSelect('settings')}
            >
              房主设置
            </button>
          )}
        </div>
        <button type="button" className="side-panel-close" onClick={onClose}>
          关闭侧边栏
        </button>
      </div>

      <section
        id="room-panel-chat"
        role="tabpanel"
        aria-labelledby="room-tab-chat"
        hidden={openTab !== 'chat'}
        className="side-panel-content"
      >
        <ChatPanel
          messages={view.messages}
          disabled={!connected}
          onSend={sendChat}
          revealVersion={chatRevealVersion}
        />
      </section>

      {isHost && (
        <section
          id="room-panel-settings"
          role="tabpanel"
          aria-labelledby="room-tab-settings"
          hidden={openTab !== 'settings'}
          className="side-panel-content"
        >
          <RoomControls
            client={client}
            view={view}
            playerId={playerId}
            connected={connected}
            onError={onError}
          />
        </section>
      )}
    </aside>
  );
}
