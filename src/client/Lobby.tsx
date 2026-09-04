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
  restoring: boolean;
  statusMessage: string;
  errorMessage: string;
}

function normalizedNickname(value: string): string | undefined {
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  const containsVisibleCharacter =
    /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(nickname);
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
  restoring,
  statusMessage,
  errorMessage: serverError,
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
      <header className="lobby-intro">
        <p className="eyebrow">私人牌局 · 局域网畅玩</p>
        <h1 id="lobby-title">局域网德州扑克</h1>
        <p>创建一个只属于朋友们的房间，或输入邀请中的房间码直接入座。</p>
      </header>
      <div className="lobby-feedback" aria-atomic="true">
        {restoring && (
          <p className="connection-banner" aria-live="polite">正在恢复上次牌局…</p>
        )}
        {!restoring && statusMessage !== '' && (
          <p className="connection-banner" aria-live="polite">{statusMessage}</p>
        )}
        {serverError !== '' && (
          <p className="error-banner" aria-live="polite">{serverError}</p>
        )}
      </div>
      <form className="lobby-form" onSubmit={(event) => void submit(
        roomCode.trim().length > 0 ? 'join' : 'create',
        event,
      )}>
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
        <div className="lobby-identity">
          <label htmlFor="nickname">昵称</label>
          <input
            id="nickname"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            disabled={formDisabled}
            autoComplete="nickname"
            placeholder="你在牌桌上的名字"
            aria-describedby={nicknameHelp === '' ? undefined : 'nickname-help'}
          />
          {nicknameHelp !== '' && <p id="nickname-help" className="field-help">{nicknameHelp}</p>}
        </div>

        <section className="lobby-choice" aria-labelledby="create-room-title">
          <h2 id="create-room-title">创建新牌局</h2>
          <p>生成一个房间码，再把邀请链接发给朋友。</p>
          <button
            type="button"
            disabled={formDisabled}
            onClick={(event) => void submit('create', event)}
          >
            {pendingAction === 'create' ? '创建中…' : '创建私人房间'}
          </button>
        </section>

        <section className="lobby-choice" aria-labelledby="join-room-title">
          <h2 id="join-room-title">加入朋友的牌局</h2>
          <label htmlFor="room-code">房间码</label>
          <input
            id="room-code"
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="例如 ABCD23"
            disabled={formDisabled}
          />
          <button
            type="button"
            disabled={formDisabled}
            onClick={(event) => void submit('join', event)}
          >
            {pendingAction === 'join' ? '加入中…' : '加入私人房间'}
          </button>
        </section>
      </form>
    </section>
  );
}
