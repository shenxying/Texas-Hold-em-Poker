import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeBasePath } from '../shared/basePath';
import type { SessionInfo, TableView } from '../shared/protocol';
import { Lobby } from './Lobby';
import { PokerRoom } from './PokerRoom';
import { RoomControls } from './RoomControls';
import type { ConnectionState, PokerClient } from './socket';

const SESSION_KEY = 'lan-poker-session';

interface SavedSession {
  roomCode: string;
  sessionToken: string;
}

interface AppProps {
  client: PokerClient;
  basePath?: string;
  locationHref?: string;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readSavedSession(): SavedSession | undefined {
  const saved = storage()?.getItem(SESSION_KEY);
  if (saved === null || saved === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(saved);
    if (
      typeof value === 'object' && value !== null &&
      'roomCode' in value && typeof value.roomCode === 'string' &&
      'sessionToken' in value && typeof value.sessionToken === 'string'
    ) {
      return { roomCode: value.roomCode, sessionToken: value.sessionToken };
    }
  } catch {
    // Invalid local data is handled exactly like an expired session.
  }
  storage()?.removeItem(SESSION_KEY);
  return undefined;
}

function saveSession(session: SessionInfo): void {
  storage()?.setItem(SESSION_KEY, JSON.stringify({
    roomCode: session.roomCode,
    sessionToken: session.sessionToken,
  }));
}

function inviteFor(locationHref: string, basePath: string, roomCode: string): string {
  const invite = new URL(`${normalizeBasePath(basePath)}/`, locationHref);
  invite.searchParams.set('room', roomCode);
  return invite.toString();
}

function connectionMessage(state: ConnectionState): string {
  if (state === 'connecting') return '正在连接服务器…';
  if (state === 'reconnecting') return '连接中断，正在重连…';
  if (state === 'disconnected') return '服务器连接已断开';
  return '';
}

export function App({
  client,
  basePath = '',
  locationHref = globalThis.location?.href ?? 'http://localhost/',
}: AppProps): React.JSX.Element {
  const initialRoomCode = useMemo(
    () => new URL(locationHref).searchParams.get('room')?.trim().toUpperCase() ?? '',
    [locationHref],
  );
  const savedSession = useRef(readSavedSession());
  const restoreAttempted = useRef(false);
  const [session, setSession] = useState<SessionInfo>();
  const [view, setView] = useState<TableView>();
  const [error, setError] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const [lobbyPending, setLobbyPending] = useState(false);
  const [restoring, setRestoring] = useState(savedSession.current !== undefined);
  const [replaced, setReplaced] = useState(false);

  useEffect(() => client.subscribe((event) => {
    if (event.type === 'table:snapshot') {
      setView(event.view);
      return;
    }
    if (event.type === 'command:error') {
      setError(event.error.message);
      return;
    }
    if (event.type === 'session:invalid') {
      savedSession.current = undefined;
      storage()?.removeItem(SESSION_KEY);
      setSession(undefined);
      setView(undefined);
      setError(event.error.message);
      setRestoring(false);
      return;
    }
    if (event.type === 'connection:state') {
      setConnectionState(event.state);
      return;
    }
    setReplaced(true);
    setError('');
  }), [client]);

  useEffect(() => {
    const saved = savedSession.current;
    if (saved === undefined || restoreAttempted.current) return;
    restoreAttempted.current = true;
    void client.reconnect(saved.sessionToken).then((restored) => {
      saveSession(restored);
      setSession(restored);
      setError('');
    }).catch((restoreError: unknown) => {
      storage()?.removeItem(SESSION_KEY);
      setSession(undefined);
      setView(undefined);
      setError(restoreError instanceof Error ? restoreError.message : '会话已失效');
    }).finally(() => setRestoring(false));
  }, [client]);

  function acceptSession(nextSession: SessionInfo): void {
    saveSession(nextSession);
    setSession(nextSession);
    setError('');
  }

  const statusMessage = connectionMessage(connectionState);
  return (
    <main className="app-shell">
      {replaced ? (
        <section className="replacement-panel" aria-live="polite">
          <h1>此会话已在另一个页面连接</h1>
          <p>请关闭此页面；如需在此页面继续，请重新加载。</p>
        </section>
      ) : (
        <>
          {statusMessage !== '' && (
            <p className="connection-banner" aria-live="polite">{statusMessage}</p>
          )}
          {error !== '' && <p className="error-banner" aria-live="polite">{error}</p>}

          {session === undefined ? (
            <Lobby
              client={client}
              initialRoomCode={initialRoomCode}
              disabled={restoring || lobbyPending || connectionState !== 'connected'}
              onPendingChange={setLobbyPending}
              onSession={acceptSession}
              onError={setError}
            />
          ) : (
            <section className="room-summary" aria-labelledby="room-title">
              <h1 id="room-title">私人房间</h1>
              <div className="invite-strip">
                <span>房间码</span>
                <strong className="room-code">{session.roomCode}</strong>
                <label htmlFor="invite-url">邀请链接</label>
                <input
                  id="invite-url"
                  readOnly
                  value={inviteFor(locationHref, basePath, session.roomCode)}
                />
              </div>
              {view !== undefined && (
                <>
                  <PokerRoom
                    client={client}
                    view={view}
                    playerId={session.playerId}
                    connected={connectionState === 'connected'}
                    onError={setError}
                  />
                  <RoomControls
                    client={client}
                    view={view}
                    playerId={session.playerId}
                    connected={connectionState === 'connected'}
                    onError={setError}
                  />
                </>
              )}
            </section>
          )}
        </>
      )}

      <p className="disclosure">仅供娱乐的虚拟筹码，不支持充值、提现或价值兑换</p>
    </main>
  );
}
