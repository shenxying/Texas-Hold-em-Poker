import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface LeaveRoomDialogProps {
  playing: boolean;
  pending: boolean;
  errorMessage: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function LeaveRoomDialog({
  playing,
  pending,
  errorMessage,
  onCancel,
  onConfirm,
}: LeaveRoomDialogProps): React.JSX.Element {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    const hadInert = appShell?.hasAttribute('inert') ?? false;
    const previousAriaHidden = appShell?.getAttribute('aria-hidden');
    appShell?.setAttribute('inert', '');
    appShell?.setAttribute('aria-hidden', 'true');
    cancelButton.current?.focus();

    return () => {
      if (!hadInert) appShell?.removeAttribute('inert');
      if (previousAriaHidden === null || previousAriaHidden === undefined) {
        appShell?.removeAttribute('aria-hidden');
      }
      else appShell?.setAttribute('aria-hidden', previousAriaHidden);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, pending]);

  return createPortal(
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        className="leave-room-dialog"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="leave-room-title"
        aria-describedby="leave-room-description"
      >
        <h2 id="leave-room-title">确认退出房间</h2>
        <p id="leave-room-description">
          {playing ? '退出将立即弃牌并离开房间。' : '确定退出当前房间吗？'}
        </p>
        {errorMessage !== '' && (
          <p className="error-banner dialog-error" aria-live="assertive">{errorMessage}</p>
        )}
        <div className="dialog-actions">
          <button
            ref={cancelButton}
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending ? '正在退出…' : '确认退出'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
