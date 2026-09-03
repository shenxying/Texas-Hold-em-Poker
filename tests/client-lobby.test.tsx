/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import type {
  PokerClient,
  PokerClientEvent,
  PokerCommand,
} from '../src/client/socket';
import type {
  ClientCommandData,
  ClientCommandInput,
  PublicPlayer,
  SessionInfo,
  TableView,
} from '../src/shared/protocol';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const hostSession: SessionInfo = {
  roomCode: 'ABCD23',
  sessionToken: 'secret-token',
  playerId: 'host-1',
};

function player(overrides: Partial<PublicPlayer> = {}): PublicPlayer {
  return {
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
    ...overrides,
  };
}

function tableView(overrides: Partial<TableView> = {}): TableView {
  return {
    version: 1,
    roomCode: 'ABCD23',
    settings: { startingStack: 10_000, smallBlind: 50, bigBlind: 100 },
    phase: 'lobby',
    players: [player()],
    board: [],
    pots: [],
    messages: [],
    ...overrides,
  };
}

class FakePokerClient implements PokerClient {
  readonly createRoom = vi.fn<(nickname: string) => Promise<SessionInfo>>();
  readonly joinRoom = vi.fn<(roomCode: string, nickname: string) => Promise<SessionInfo>>();
  readonly reconnect = vi.fn<(sessionToken: string) => Promise<SessionInfo>>();
  readonly sent: Array<{ command: PokerCommand; input: unknown }> = [];
  private listeners = new Set<(event: PokerClientEvent) => void>();

  constructor(options: {
    createRoom?: SessionInfo | Promise<SessionInfo>;
    joinRoom?: SessionInfo | Promise<SessionInfo>;
    reconnect?: SessionInfo | Promise<SessionInfo>;
  } = {}) {
    this.createRoom.mockImplementation(() => Promise.resolve(options.createRoom ?? hostSession));
    this.joinRoom.mockImplementation(() => Promise.resolve(options.joinRoom ?? hostSession));
    this.reconnect.mockImplementation(() => Promise.resolve(options.reconnect ?? hostSession));
  }

  send<Command extends PokerCommand>(
    command: Command,
    input: ClientCommandInput<Command>,
  ): Promise<ClientCommandData<Command>> {
    this.sent.push({ command, input });
    return Promise.resolve({} as ClientCommandData<Command>);
  }

  subscribe(listener: (event: PokerClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PokerClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
});

describe('lobby and browser session', () => {
  it('creates a room from a valid nickname and displays a token-safe invitation', async () => {
    const client = new FakePokerClient({ createRoom: hostSession });
    render(<App client={client} locationHref="http://192.168.1.8:3000/path?old=value" />);

    await userEvent.type(screen.getByLabelText('昵称'), '小明');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));

    expect(await screen.findByText('ABCD23')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://192.168.1.8:3000/?room=ABCD23')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/secret-token/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('lan-poker-session')!)).toEqual({
      roomCode: 'ABCD23',
      sessionToken: 'secret-token',
    });
  });

  it('prefills and uppercases a room code from an invitation URL', () => {
    render(<App client={new FakePokerClient()} locationHref="http://host/?room=abcd23" />);

    expect(screen.getByLabelText('房间码')).toHaveValue('ABCD23');
  });

  it('normalizes a typed room code before joining', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), ' 朋友 ');
    await userEvent.type(screen.getByLabelText('房间码'), 'abcd23');
    await userEvent.click(screen.getByRole('button', { name: '加入私人房间' }));

    await screen.findByText('ABCD23');
    expect(client.joinRoom).toHaveBeenCalledWith('ABCD23', '朋友');
  });

  it('creates on Enter when the room code is empty', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), '房主{Enter}');

    await screen.findByText('ABCD23');
    expect(client.createRoom).toHaveBeenCalledWith('房主');
    expect(client.joinRoom).not.toHaveBeenCalled();
  });

  it('joins on Enter when an invitation prefilled the room code', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/?room=abcd23" />);

    await userEvent.type(screen.getByLabelText('昵称'), '朋友{Enter}');

    await screen.findByText('ABCD23');
    expect(client.joinRoom).toHaveBeenCalledWith('ABCD23', '朋友');
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('keeps invalid nicknames local and allows twenty visible Unicode characters', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), '   ');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    expect(screen.getByText('昵称必须包含 1–20 个可见字符')).toBeInTheDocument();
    expect(client.createRoom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '\u200B\u200D\u0001' } });
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    expect(screen.getByText('昵称必须包含 1–20 个可见字符')).toBeInTheDocument();
    expect(client.createRoom).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('昵称'));
    await userEvent.type(screen.getByLabelText('昵称'), '😀'.repeat(20));
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    await screen.findByText('ABCD23');
    expect(client.createRoom).toHaveBeenCalledWith('😀'.repeat(20));
  });

  it('allows an emoji nickname containing a zero-width joiner', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '👩‍💻' } });
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));

    await screen.findByText('ABCD23');
    expect(client.createRoom).toHaveBeenCalledWith('👩‍💻');
  });

  it.each([
    ['VS16', '\uFE0F'],
    ['CGJ', '\u034F'],
  ])('keeps a %s-only nickname local', async (_label, nickname) => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: nickname } });
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));

    expect(screen.getByText('昵称必须包含 1–20 个可见字符')).toBeInTheDocument();
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('disables lobby submissions while awaiting acknowledgement and announces server errors', async () => {
    const pending = deferred<SessionInfo>();
    const client = new FakePokerClient({ createRoom: pending.promise });
    render(<App client={client} locationHref="http://host/" />);

    await userEvent.type(screen.getByLabelText('昵称'), '小明');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '加入私人房间' })).toBeDisabled();

    pending.reject(new Error('昵称已被使用'));
    expect(await screen.findByText('昵称已被使用')).toHaveAttribute('aria-live', 'polite');
  });

  it('reconnects a saved token once and clears an invalid saved session', async () => {
    localStorage.setItem('lan-poker-session', JSON.stringify({
      roomCode: 'ABCD23',
      sessionToken: 'expired-token',
    }));
    const client = new FakePokerClient();
    client.reconnect.mockRejectedValue(new Error('会话已失效'));

    const { rerender } = render(<App client={client} locationHref="http://host/" />);

    expect(await screen.findByText('会话已失效')).toBeInTheDocument();
    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('lan-poker-session')).toBeNull();
    expect(screen.getByLabelText('昵称')).toBeEnabled();

    rerender(<App client={client} locationHref="http://host/" />);
    expect(client.reconnect).toHaveBeenCalledTimes(1);
  });

  it('announces connection loss without discarding server wording', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);

    client.publish({ type: 'connection:state', state: 'reconnecting' });
    expect(await screen.findByText('连接中断，正在重连…')).toHaveAttribute('aria-live', 'polite');

    client.publish({ type: 'command:error', error: { code: 'ROOM_FULL', message: '房间已满' } });
    expect(await screen.findByText('房间已满')).toBeInTheDocument();

  });

  it('preserves shared storage and makes a replaced session terminal in this tab', async () => {
    const client = new FakePokerClient();
    render(<App client={client} locationHref="http://host/" />);
    await userEvent.type(screen.getByLabelText('昵称'), '房主');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    await screen.findByText('ABCD23');

    const saved = localStorage.getItem('lan-poker-session');
    client.publish({ type: 'table:snapshot', view: tableView() });
    client.publish({ type: 'session:replaced', roomCode: 'ABCD23' });

    expect(await screen.findByText('此会话已在另一个页面连接')).toBeInTheDocument();
    expect(screen.getByText('请关闭此页面；如需在此页面继续，请重新加载。')).toBeInTheDocument();
    expect(localStorage.getItem('lan-poker-session')).toBe(saved);
    expect(screen.queryByLabelText('昵称')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('初始筹码')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    client.publish({ type: 'connection:state', state: 'connected' });
    expect(screen.queryByLabelText('昵称')).not.toBeInTheDocument();
  });
});

describe('host room controls', () => {
  async function enterRoom(client: FakePokerClient, view: TableView): Promise<void> {
    render(<App client={client} locationHref="http://host/" />);
    await userEvent.type(screen.getByLabelText('昵称'), '房主');
    await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
    await screen.findByText('ABCD23');
    client.publish({ type: 'table:snapshot', view });
    await screen.findByText('房主设置');
  }

  it('shows editable settings, bot management, and busted-human reset only to the host', async () => {
    const client = new FakePokerClient();
    await enterRoom(client, tableView({
      players: [
        player({ stack: 0 }),
        player({ id: 'bot-1', nickname: 'Bot 1', seatIndex: 1, isBot: true,
          isHost: false, botStyle: 'balanced' }),
      ],
    }));

    expect(await screen.findByLabelText('初始筹码')).toHaveValue(10_000);
    expect(screen.getByLabelText('小盲')).toHaveValue(50);
    expect(screen.getByLabelText('大盲')).toHaveValue(100);
    expect(screen.getByLabelText('AI 风格')).toHaveValue('balanced');
    expect(screen.getByRole('button', { name: '移除 Bot 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重置 房主 筹码' })).toBeEnabled();

    client.publish({
      type: 'table:snapshot',
      view: tableView({ players: [player({ id: 'guest-1', isHost: false })] }),
    });
    await waitFor(() => expect(screen.queryByLabelText('初始筹码')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '添加 AI' })).not.toBeInTheDocument();
  });

  it('sends valid settings and host commands using snapshot identities', async () => {
    const client = new FakePokerClient();
    await enterRoom(client, tableView({
      players: [
        player({ stack: 0 }),
        player({ id: 'bot-1', nickname: 'Bot 1', seatIndex: 1, isBot: true,
          isHost: false, botStyle: 'tight' }),
      ],
    }));

    await userEvent.clear(screen.getByLabelText('初始筹码'));
    await userEvent.type(screen.getByLabelText('初始筹码'), '20000');
    await userEvent.clear(screen.getByLabelText('小盲'));
    await userEvent.type(screen.getByLabelText('小盲'), '100');
    await userEvent.clear(screen.getByLabelText('大盲'));
    await userEvent.type(screen.getByLabelText('大盲'), '200');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(client.sent).toContainEqual({
      command: 'room:update-settings',
      input: { settings: { startingStack: 20_000, smallBlind: 100, bigBlind: 200 } },
    });

    await userEvent.selectOptions(screen.getByLabelText('AI 风格'), 'aggressive');
    await userEvent.click(screen.getByRole('button', { name: '添加 AI' }));
    expect(client.sent).toContainEqual({ command: 'room:add-bot', input: { style: 'aggressive' } });

    await userEvent.click(screen.getByRole('button', { name: '移除 Bot 1' }));
    expect(client.sent).toContainEqual({
      command: 'room:remove-bot', input: { playerId: 'bot-1' },
    });

    await userEvent.click(screen.getByRole('button', { name: '重置 房主 筹码' }));
    expect(client.sent).toContainEqual({
      command: 'room:reset-stack', input: { playerId: 'host-1' },
    });
  });

  it('shows local settings help at exact boundaries and does not send invalid values', async () => {
    const client = new FakePokerClient();
    await enterRoom(client, tableView());

    await userEvent.clear(screen.getByLabelText('初始筹码'));
    await userEvent.type(screen.getByLabelText('初始筹码'), '999');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(screen.getByText('初始筹码必须是 1,000–1,000,000 的整数')).toBeInTheDocument();
    expect(client.sent).not.toContainEqual(expect.objectContaining({
      command: 'room:update-settings',
    }));

    await userEvent.clear(screen.getByLabelText('初始筹码'));
    await userEvent.type(screen.getByLabelText('初始筹码'), '1000');
    await userEvent.clear(screen.getByLabelText('小盲'));
    await userEvent.type(screen.getByLabelText('小盲'), '51');
    await userEvent.clear(screen.getByLabelText('大盲'));
    await userEvent.type(screen.getByLabelText('大盲'), '50');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(screen.getByText('大盲必须不小于小盲，且不能超过初始筹码')).toBeInTheDocument();
  });

  it('disables every host control while a hand is playing', async () => {
    const client = new FakePokerClient();
    await enterRoom(client, tableView({
      phase: 'playing',
      players: [
        player({ stack: 0 }),
        player({ id: 'bot-1', nickname: 'Bot 1', seatIndex: 1, isBot: true,
          isHost: false, botStyle: 'balanced' }),
      ],
    }));

    expect(await screen.findByLabelText('初始筹码')).toBeDisabled();
    expect(screen.getByLabelText('小盲')).toBeDisabled();
    expect(screen.getByLabelText('大盲')).toBeDisabled();
    expect(screen.getByLabelText('AI 风格')).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加 AI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除 Bot 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重置 房主 筹码' })).toBeDisabled();
  });
});
