import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../shared/protocol';

interface ChatPanelProps {
  messages: readonly ChatMessage[];
  onSend: (text: string) => Promise<unknown>;
  disabled: boolean;
}

export function ChatPanel({ messages, onSend, disabled }: ChatPanelProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followNewest = useRef(true);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list !== null && followNewest.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

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
          maxLength={300}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled || pending}
        />
        <button type="submit" disabled={disabled || pending || text.trim().length === 0}>发送</button>
      </form>
    </section>
  );
}
