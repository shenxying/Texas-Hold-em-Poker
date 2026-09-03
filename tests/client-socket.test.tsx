/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/client/App';
import {
  createPokerClient,
  SocketPokerClient,
  socketPathFor,
  type PokerClientEvent,
} from '../src/client/socket';
import type { CommandResponse, SessionInfo, TableView } from '../src/shared/protocol';

type Listener = (...args: never[]) => void;

const session: SessionInfo = {
  roomCode: 'ABCD23',
  sessionToken: 'session-secret',
  playerId: 'host-1',
};

const snapshot: TableView = {
  version: 2,
  roomCode: 'ABCD23',
  settings: { startingStack: 10_000, smallBlind: 50, bigBlind: 100 },
  phase: 'lobby',
  players: [],
  board: [],
  pots: [],
  messages: [],
};

const hostSnapshot: TableView = {
  ...snapshot,
  players: [{
    id: 'host-1',
    nickname: '房主',
    seatIndex: 0,
    stack: 10_000,
    streetBet: 0,
    connected: true,
    isBot: false,
    isHost: true,
    folded: false,
    allIn: false,
    holeCardCount: 0,
  }],
};

class MockSocketTransport {
  connected = false;
  active = true;
  readonly emissions: Array<{
    event: string;
    input: unknown;
    acknowledge: (response: CommandResponse<unknown>) => void;
  }> = [];
  readonly io = {
    on: (event: string, listener: Listener): void => this.add(this.managerListeners, event, listener),
  };
  private readonly socketListeners = new Map<string, Listener[]>();
  private readonly managerListeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.add(this.socketListeners, event, listener);
    return this;
  }

  emit(
    event: string,
    input: unknown,
    acknowledge: (response: CommandResponse<unknown>) => void,
  ): this {
    this.emissions.push({ event, input, acknowledge });
    return this;
  }

  connect(): void {
    this.connected = true;
    this.fire(this.socketListeners, 'connect');
  }

  disconnect(): void {
    this.connected = false;
    this.fire(this.socketListeners, 'disconnect');
  }

  serverEvent(event: string, payload: unknown): void {
    this.fire(this.socketListeners, event, payload);
  }

  respond(index: number, response: CommandResponse<unknown>): void {
    this.emissions[index]!.acknowledge(response);
  }

  private add(target: Map<string, Listener[]>, event: string, listener: Listener): void {
    const listeners = target.get(event) ?? [];
    listeners.push(listener);
    target.set(event, listeners);
  }

  private fire(target: Map<string, Listener[]>, event: string, ...args: unknown[]): void {
    for (const listener of target.get(event) ?? []) listener(...args as never[]);
  }
}

function createHarness(): {
  socket: MockSocketTransport;
  client: SocketPokerClient;
  events: PokerClientEvent[];
} {
  const socket = new MockSocketTransport();
  const client = new SocketPokerClient(socket as never);
  const events: PokerClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { socket, client, events };
}

async function bindCreatedSession(
  socket: MockSocketTransport,
  client: SocketPokerClient,
): Promise<void> {
  const created = client.createRoom('房主');
  socket.respond(0, { ok: true, data: session });
  await created;
}

afterEach(() => cleanup());

beforeEach(() => localStorage.clear());

describe('SocketPokerClient transport lifecycle', () => {
  it('derives the Socket.IO transport path from the explicit public base path', () => {
    expect(socketPathFor('/poker/')).toBe('/poker/socket.io');
    expect(socketPathFor('/')).toBe('/socket.io');
  });

  it('accepts a supplied transport through the client options object', () => {
    const socket = new MockSocketTransport();

    expect(createPokerClient({ socket: socket as never, basePath: '/poker' }))
      .toBeInstanceOf(SocketPokerClient);
  });

  it('does not double-bind when initial connect happens during explicit session restore', async () => {
    const { socket, client } = createHarness();

    const restored = client.reconnect('session-secret');
    socket.connect();
    socket.respond(0, { ok: true, data: session });
    await restored;

    expect(socket.emissions.map(({ event }) => event)).toEqual(['room:reconnect']);
  });

  it('rebinds after transport reconnect and stays recovering until snapshot and ack arrive', async () => {
    const { socket, client, events } = createHarness();
    socket.connect();
    await bindCreatedSession(socket, client);

    socket.disconnect();
    socket.connect();
    const connectedBeforeRecovery = events.filter(
      (event) => event.type === 'connection:state' && event.state === 'connected',
    ).length;

    expect(socket.emissions[1]).toMatchObject({
      event: 'room:reconnect',
      input: { sessionToken: 'session-secret' },
    });
    expect(events.at(-1)).toEqual({ type: 'connection:state', state: 'reconnecting' });

    socket.serverEvent('table:snapshot', snapshot);
    expect(events.at(-1)).toEqual({ type: 'table:snapshot', view: snapshot });
    expect(events.filter(
      (event) => event.type === 'connection:state' && event.state === 'connected',
    )).toHaveLength(connectedBeforeRecovery);

    socket.respond(1, { ok: true, data: session });
    await Promise.resolve();
    expect(events.at(-1)).toEqual({ type: 'connection:state', state: 'connected' });
  });

  it('clears a rejected recovery binding and returns the connected transport to the lobby', async () => {
    const { socket, client, events } = createHarness();
    socket.connect();
    await bindCreatedSession(socket, client);

    socket.disconnect();
    socket.connect();
    const error = { code: 'INVALID_SESSION', message: '会话已失效' };
    socket.serverEvent('command:error', error);
    socket.respond(1, { ok: false, error });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContainEqual({ type: 'command:error', error });
    expect(events.at(-1)).toEqual({ type: 'connection:state', state: 'connected' });

    socket.disconnect();
    socket.connect();
    expect(socket.emissions).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'connection:state', state: 'connected' });
  });

  it('retains the bound session when an ordinary room command is rejected', async () => {
    const { socket, client } = createHarness();
    socket.connect();
    await bindCreatedSession(socket, client);

    const command = client.send('room:add-bot', { style: 'balanced' });
    socket.respond(1, {
      ok: false,
      error: { code: 'NOT_HOST', message: '只有房主可以添加 AI' },
    });
    await expect(command).rejects.toMatchObject({ code: 'NOT_HOST' });

    socket.disconnect();
    socket.connect();
    expect(socket.emissions[2]).toMatchObject({
      event: 'room:reconnect',
      input: { sessionToken: 'session-secret' },
    });
  });

  it('keeps React host controls disabled until transport recovery has a fresh snapshot and ack', async () => {
    const socket = new MockSocketTransport();
    socket.connected = true;
    const client = new SocketPokerClient(socket as never);
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), '房主');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    socket.respond(0, { ok: true, data: session });
    expect(await screen.findByText('ABCD23')).toBeInTheDocument();
    socket.serverEvent('table:snapshot', hostSnapshot);
    expect(await screen.findByRole('button', { name: '保存设置' })).toBeEnabled();

    socket.disconnect();
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled());
    socket.connect();
    socket.serverEvent('table:snapshot', hostSnapshot);
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();

    socket.respond(1, { ok: true, data: session });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled());
  });

  it('returns React to an enabled lobby when transport recovery finds an expired session', async () => {
    const socket = new MockSocketTransport();
    socket.connected = true;
    const client = new SocketPokerClient(socket as never);
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), '房主');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    socket.respond(0, { ok: true, data: session });
    expect(await screen.findByText('ABCD23')).toBeInTheDocument();
    socket.serverEvent('table:snapshot', hostSnapshot);
    expect(localStorage.getItem('lan-poker-session')).not.toBeNull();

    socket.disconnect();
    socket.connect();
    socket.respond(1, {
      ok: false,
      error: { code: 'INVALID_SESSION', message: '服务器重启，会话已失效' },
    });

    expect(await screen.findByText('服务器重启，会话已失效')).toBeInTheDocument();
    expect(screen.getByLabelText('昵称')).toBeEnabled();
    expect(screen.queryByText('私人房间')).not.toBeInTheDocument();
    expect(localStorage.getItem('lan-poker-session')).toBeNull();
  });
});
