import { io } from 'socket.io-client';

const clients = [];

function bounded(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), 10_000);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function connect() {
  const socket = io('http://127.0.0.1:8080', {
    path: '/poker/socket.io',
    transports: ['websocket'],
    forceNew: true,
  });
  clients.push(socket);
  await bounded(new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  }), 'connect');
  return socket;
}

function ack(socket, event, payload) {
  return bounded(new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (response?.ok) resolve(response.data);
      else reject(new Error(`${event} rejected: ${response?.error?.code ?? 'unknown'}`));
    });
  }), event);
}

const latest = new WeakMap();

function watch(socket) {
  socket.on('table:snapshot', (view) => latest.set(socket, view));
}

function snapshot(socket, predicate) {
  return bounded(new Promise((resolve) => {
    const current = latest.get(socket);
    if (current && predicate(current)) {
      resolve(current);
      return;
    }
    const listener = (view) => {
      if (!predicate(view)) return;
      socket.off('table:snapshot', listener);
      resolve(view);
    };
    socket.on('table:snapshot', listener);
  }), 'table:snapshot');
}

try {
  const host = await connect();
  const guest = await connect();
  watch(host);
  watch(guest);
  const created = await ack(host, 'room:create', { nickname: 'smoke-host' });
  const joined = await ack(guest, 'room:join', {
    roomCode: created.roomCode,
    nickname: 'smoke-guest',
  });
  const plain = 'plain smoke message';
  const htmlLike = '<img src=x onerror=alert(1)> smoke';
  const plainResult = await ack(host, 'chat:send', { text: plain });
  const htmlResult = await ack(guest, 'chat:send', { text: htmlLike });
  if (plainResult.message.text !== plain || htmlResult.message.text !== htmlLike) {
    throw new Error('chat text mismatch');
  }
  await ack(host, 'game:start', {});
  const hostView = await snapshot(host, (view) => view.phase === 'playing');
  const actorSocket = hostView.actorId === created.playerId
    ? host
    : hostView.actorId === joined.playerId
      ? guest
      : undefined;
  if (!actorSocket) throw new Error('actor does not belong to either smoke client');
  const actorView = await snapshot(
    actorSocket,
    (view) => view.phase === 'playing' && view.legalActions !== undefined,
  );
  const legal = actorView.legalActions;
  const action = legal.canCheck ? { type: 'check' }
    : legal.canCall ? { type: 'call' }
      : legal.canFold ? { type: 'fold' }
        : legal.canAllIn ? { type: 'all-in' }
          : legal.canBet ? { type: 'bet', amount: legal.minRaiseTo }
            : legal.canRaise ? { type: 'raise', amount: legal.minRaiseTo }
              : undefined;
  if (!action) throw new Error('no legal smoke action');
  await ack(actorSocket, 'game:act', action);
  console.log('Poker WebSocket two-client smoke=PASS');
} finally {
  for (const socket of clients) socket.disconnect();
}
