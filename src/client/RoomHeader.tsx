import { useRef, useState } from 'react';
import { LeaveRoomDialog } from './LeaveRoomDialog';
import type { RoomPanelTab } from './RoomSidePanel';

interface RoomHeaderProps {
  roomCode: string;
  inviteUrl: string;
  connected: boolean;
  playing: boolean;
  leaving: boolean;
  isHost: boolean;
  openTab: RoomPanelTab | null;
  panelAvailable?: boolean;
  onOpenPanel: (tab: RoomPanelTab) => void;
  onLeave: () => Promise<void>;
}

export function RoomHeader({
  roomCode,
  inviteUrl,
  connected,
  playing,
  leaving,
  isHost,
  openTab,
  panelAvailable = true,
  onOpenPanel,
  onLeave,
}: RoomHeaderProps): React.JSX.Element {
  const leaveButton = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');

  function closeDialog(): void {
    if (leaving) return;
    setDialogOpen(false);
    setDialogError('');
    queueMicrotask(() => leaveButton.current?.focus());
  }

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyStatus('邀请链接已复制');
    } catch {
      setCopyStatus('复制失败，请稍后重试');
    }
  }

  async function confirmLeave(): Promise<void> {
    if (leaving) return;
    setDialogError('');
    try {
      await onLeave();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '暂时无法退出房间');
    }
  }

  return (
    <>
      <header className="room-header">
        <div className="room-brand">
          <span className="room-brand-name">局域网德州扑克</span>
          <span className="room-connection" data-connected={connected}>
            {connected ? '已连接' : '连接中断'}
          </span>
        </div>
        <div className="room-invite" aria-label="房间邀请">
          <span>房间码</span>
          <strong className="room-code">{roomCode}</strong>
          <button type="button" className="secondary-button" onClick={() => void copyInvite()}>
            复制邀请链接
          </button>
          <span className="copy-status" aria-live="polite">{copyStatus}</span>
        </div>
        <nav className="room-tools" aria-label="房间工具">
          <button
            id="room-open-chat"
            type="button"
            className="secondary-button"
            aria-controls="room-side-panel"
            aria-expanded={openTab === 'chat'}
            disabled={!panelAvailable}
            onClick={() => onOpenPanel('chat')}
          >
            聊天
          </button>
          {isHost && (
            <button
              id="room-open-settings"
              type="button"
              className="secondary-button"
              aria-controls="room-side-panel"
              aria-expanded={openTab === 'settings'}
              disabled={!panelAvailable}
              onClick={() => onOpenPanel('settings')}
            >
              房主设置
            </button>
          )}
        </nav>
        <button
          ref={leaveButton}
          type="button"
          className="danger-button"
          onClick={() => {
            setDialogError('');
            setDialogOpen(true);
          }}
        >
          退出房间
        </button>
      </header>
      {dialogOpen && (
        <LeaveRoomDialog
          playing={playing}
          pending={leaving}
          errorMessage={dialogError}
          onCancel={closeDialog}
          onConfirm={confirmLeave}
        />
      )}
    </>
  );
}
