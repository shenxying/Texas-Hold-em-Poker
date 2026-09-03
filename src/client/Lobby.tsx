import { useState, type FormEvent } from 'react';
import type { SessionInfo } from '../shared/protocol';
import type { PokerClient } from './socket';

interface LobbyProps {
  client: PokerClient;
  initialRoomCode: string;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSession: (session: SessionInfo) => void;
  onError: (message: string) => void;
}

function normalizedNickname(value: string): string | undefined {
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  const containsVisibleCharacter = /[^\s\p{Cc}\p{Cf}]/u.test(nickname);
  return length >= 1 && length <= 20 && containsVisibleCharacter ? nickname : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export function Lobby({
  client,
  initialRoomCode,
  disabled,
  onPendingChange,
  onSession,
  onError,
}: LobbyProps): React.JSX.Element {
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState(initialRoomCode);
  const [nicknameHelp, setNicknameHelp] = useState('');
  const [pendingAction, setPendingAction] = useState<'create' | 'join' | null>(null);

  async function submit(action: 'create' | 'join', event: FormEvent): Promise<void> {
    event.preventDefault();
    const validNickname = normalizedNickname(nickname);
    if (validNickname === undefined) {
      setNicknameHelp('昵称必须包含 1–20 个可见字符');
      return;
    }
    const normalizedCode = roomCode.trim().toUpperCase();
    if (action === 'join' && normalizedCode.length === 0) {
      onError('请输入房间码');
      return;
    }

    setNicknameHelp('');
    setPendingAction(action);
    onPendingChange(true);
    try {
      const session = action === 'create'
        ? await client.createRoom(validNickname)
        : await client.joinRoom(normalizedCode, validNickname);
      onSession(session);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPendingAction(null);
      onPendingChange(false);
    }
  }

  const formDisabled = disabled || pendingAction !== null;
  return (
    <section className="lobby" aria-labelledby="lobby-title">
      <h1 id="lobby-title">局域网德州扑克</h1>
      <form onSubmit={(event) => void submit(
        roomCode.trim().length > 0 ? 'join' : 'create',
        event,
      )}>
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
        <label htmlFor="nickname">昵称</label>
        <input
          id="nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          disabled={formDisabled}
          aria-describedby={nicknameHelp === '' ? undefined : 'nickname-help'}
        />
        {nicknameHelp !== '' && <p id="nickname-help" className="field-help">{nicknameHelp}</p>}

        <button
          type="button"
          disabled={formDisabled}
          onClick={(event) => void submit('create', event)}
        >
          {pendingAction === 'create' ? '创建中…' : '创建私人房间'}
        </button>

        <label htmlFor="room-code">房间码</label>
        <input
          id="room-code"
          value={roomCode}
          onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
          autoCapitalize="characters"
          disabled={formDisabled}
        />
        <button
          type="button"
          disabled={formDisabled}
          onClick={(event) => void submit('join', event)}
        >
          {pendingAction === 'join' ? '加入中…' : '加入私人房间'}
        </button>
      </form>
    </section>
  );
}
