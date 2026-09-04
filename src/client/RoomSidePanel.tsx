import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 760px)').matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 760px)');
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return narrow;
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
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  const narrowScreen = useNarrowScreen();
  const panelOpen = openTab !== null;
  const isHost = view.players.some((player) => player.id === playerId && player.isHost);
  const tabs: RoomPanelTab[] = isHost ? ['chat', 'settings'] : ['chat'];
  latestClose.current = onClose;

  useEffect(() => {
    if (!narrowScreen || !panelOpen) return undefined;
    const panel = panelRef.current;
    if (panel === null) return undefined;
    const background = Array.from(document.querySelectorAll<HTMLElement>(
      '.room-header, .table-stage, .player-dock',
    ));
    const priorInert = background.map((element) => element.hasAttribute('inert'));
    background.forEach((element) => element.setAttribute('inert', ''));

    const handleModalKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        latestClose.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => (
        element.tabIndex >= 0 && element.closest('[hidden], [aria-hidden="true"]') === null
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleModalKey);
    queueMicrotask(() => closeButtonRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', handleModalKey);
      background.forEach((element, index) => {
        if (!priorInert[index]) element.removeAttribute('inert');
      });
    };
  }, [narrowScreen, panelOpen]);

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
      ref={panelRef}
      id="room-side-panel"
      className={`room-side-panel${openTab === null ? ' closed' : ' open'}`}
      aria-label="房间侧边栏"
      aria-modal={narrowScreen && panelOpen ? true : undefined}
      role={narrowScreen ? 'dialog' : undefined}
      tabIndex={narrowScreen ? -1 : undefined}
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
        <button ref={closeButtonRef} type="button" className="side-panel-close" onClick={onClose}>
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
