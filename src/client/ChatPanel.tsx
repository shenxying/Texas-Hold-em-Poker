import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../shared/protocol';

interface ChatPanelProps {
  messages: readonly ChatMessage[];
  onSend: (text: string) => Promise<unknown>;
  disabled: boolean;
  revealVersion?: number;
}

const MAX_MESSAGE_CODE_POINTS = 300;

function limitMessage(value: string): string {
  return Array.from(value).slice(0, MAX_MESSAGE_CODE_POINTS).join('');
}

export function ChatPanel({
  messages,
  onSend,
  disabled,
  revealVersion = 0,
}: ChatPanelProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followNewest = useRef(true);
  const lastRevealVersion = useRef(revealVersion);

  useLayoutEffect(() => {
    const list = listRef.current;
    const wasRevealed = lastRevealVersion.current !== revealVersion;
    if (wasRevealed) followNewest.current = true;
    if (list !== null && (followNewest.current || wasRevealed)) {
      list.scrollTop = list.scrollHeight;
    }
    lastRevealVersion.current = revealVersion;
  }, [messages, revealVersion]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = text.trim();
    if (message.length === 0 || pending || disabled) return;
    setPending(true);
    try {
      await onSend(message);
      setText('');
    } catch {
      // The owner announces the authoritative server error; retain the draft for retry.
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <h2 id="chat-title">房间聊天</h2>
      <div
        className="chat-messages"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          followNewest.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        }}
      >
        {messages.length === 0 && <p className="chat-empty">还没有消息</p>}
        {messages.map((message) => (
          <p
            className={`chat-message ${message.kind}`}
            key={message.id}
            {...(message.kind === 'system' ? { 'aria-live': 'polite' as const } : {})}
          >
            {message.kind === 'player' && message.sender !== undefined && (
              <strong>{message.sender.nickname}： </strong>
            )}
            {message.text}
          </p>
        ))}
      </div>
      <form className="chat-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="chat-message">聊天消息</label>
        <textarea
          id="chat-message"
          value={text}
          onChange={(event) => setText(limitMessage(event.target.value))}
          disabled={disabled || pending}
        />
        <button type="submit" disabled={disabled || pending || text.trim().length === 0}>发送</button>
      </form>
    </section>
  );
}
