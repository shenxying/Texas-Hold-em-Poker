import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeBasePath } from '../shared/basePath';
import type { SessionInfo, TableView } from '../shared/protocol';
import { Lobby } from './Lobby';
import { PokerRoom } from './PokerRoom';
import { RoomControls } from './RoomControls';
import { RoomHeader } from './RoomHeader';
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
  const [lobbyRoomCode, setLobbyRoomCode] = useState(initialRoomCode);
  const savedSession = useRef(readSavedSession());
  const restoreAttempted = useRef(false);
  const [session, setSession] = useState<SessionInfo>();
  const [view, setView] = useState<TableView>();
  const [error, setError] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const connectionStateRef = useRef<ConnectionState>('connected');
  const [lobbyPending, setLobbyPending] = useState(false);
  const [restoring, setRestoring] = useState(savedSession.current !== undefined);
  const [replaced, setReplaced] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leavePending = useRef(false);
  const interruptLeave = useRef<(() => void) | undefined>(undefined);

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
      connectionStateRef.current = event.state;
      setConnectionState(event.state);
      if (event.state !== 'connected') interruptLeave.current?.();
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

  function returnHome(): void {
    savedSession.current = undefined;
    try {
      storage()?.removeItem(SESSION_KEY);
    } catch {
      // Storage cleanup is best-effort; in-memory logout must still complete.
    }
    setSession(undefined);
    setView(undefined);
    setError('');
    setRestoring(false);
    setLobbyRoomCode('');

    try {
      const current = new URL(globalThis.location?.href ?? locationHref);
      current.searchParams.delete('room');
      globalThis.history?.replaceState(
        null,
        '',
        `${current.pathname}${current.search}${current.hash}`,
      );
    } catch {
      // A restricted browser history must not prevent returning to the lobby.
    }
  }

  async function leaveRoom(): Promise<void> {
    if (leavePending.current) return;
    leavePending.current = true;
    setLeaving(true);
    try {
      if (connectionStateRef.current !== 'connected') {
        await client.leaveRoom(true);
      } else {
        const interrupted = new Promise<void>((resolve) => {
          interruptLeave.current = resolve;
        });
        const outcome = await Promise.race([
          client.leaveRoom(false).then(() => 'acknowledged' as const),
          interrupted.then(() => 'offline' as const),
        ]);
        if (outcome === 'offline') await client.leaveRoom(true);
      }
      returnHome();
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : '暂时无法退出房间');
      throw leaveError;
    } finally {
      interruptLeave.current = undefined;
      leavePending.current = false;
      setLeaving(false);
    }
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
          {session === undefined ? (
            <Lobby
              client={client}
              initialRoomCode={lobbyRoomCode}
              disabled={restoring || lobbyPending || connectionState !== 'connected'}
              onPendingChange={setLobbyPending}
              onSession={acceptSession}
              onError={setError}
              restoring={restoring}
              statusMessage={statusMessage}
              errorMessage={error}
            />
          ) : (
            <>
              {statusMessage !== '' && (
                <p className="connection-banner" aria-live="polite">{statusMessage}</p>
              )}
              {error !== '' && <p className="error-banner" aria-live="polite">{error}</p>}
              <section className="room-summary" aria-label="私人房间">
                <RoomHeader
                  roomCode={session.roomCode}
                  inviteUrl={inviteFor(locationHref, basePath, session.roomCode)}
                  connected={connectionState === 'connected'}
                  playing={view?.phase === 'playing'}
                  leaving={leaving}
                  onLeave={leaveRoom}
                />
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
            </>
          )}
        </>
      )}

      <p className="disclosure">仅供娱乐的虚拟筹码，不支持充值、提现或价值兑换</p>
    </main>
  );
}
