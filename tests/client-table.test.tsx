/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionBar } from '../src/client/ActionBar';
import { ChatPanel } from '../src/client/ChatPanel';
import { PlayingCard } from '../src/client/PlayingCard';
import { PokerRoom } from '../src/client/PokerRoom';
import type { PokerClient, PokerClientEvent, PokerCommand } from '../src/client/socket';
import type {
  ChatMessage,
  ClientCommandData,
  ClientCommandInput,
  PublicPlayer,
  SessionInfo,
  TableView,
} from '../src/shared/protocol';

function player(overrides: Partial<PublicPlayer> = {}): PublicPlayer {
  return {
    id: 'me',
    nickname: '小明',
    seatIndex: 0,
    stack: 2_000,
    streetBet: 100,
    connected: true,
    isBot: false,
    isHost: true,
    folded: false,
    allIn: false,
    lastAction: 'call',
    holeCardCount: 2,
    holeCards: [{ rank: 14, suit: 'h' }, { rank: 13, suit: 's' }],
    ...overrides,
  };
}

function viewWith(overrides: Partial<TableView> = {}): TableView {
  return {
    version: 1,
    roomCode: 'ABCD23',
    settings: { startingStack: 10_000, smallBlind: 50, bigBlind: 100 },
    phase: 'playing',
    players: [
      player(),
      player({
        id: 'guest', nickname: '朋友', seatIndex: 3, isHost: false, streetBet: 200,
        lastAction: 'raise', holeCards: undefined,
      }),
      player({
        id: 'bot', nickname: '机器人', seatIndex: 7, isBot: true, isHost: false,
        streetBet: 50, lastAction: 'fold', folded: true, holeCards: undefined,
      }),
    ],
    board: [{ rank: 12, suit: 'd' }, { rank: 10, suit: 'c' }, { rank: 2, suit: 'h' }],
    pots: [{ amount: 600 }, { amount: 150 }],
    actorId: 'me',
    dealerSeatIndex: 0,
    legalActions: {
      canFold: true,
      canCheck: false,
      canCall: true,
      canBet: false,
      canRaise: true,
      canAllIn: true,
      callAmount: 100,
      minRaiseTo: 300,
      maxRaiseTo: 2_000,
    },
    actionDeadline: Date.now() + 30_000,
    messages: [],
    ...overrides,
  };
}

class FakePokerClient implements PokerClient {
  readonly sent: Array<{ command: PokerCommand; input: unknown }> = [];
  readonly deferredCommands = new Set<PokerCommand>();
  failure?: Error;

  createRoom(): Promise<SessionInfo> { throw new Error('unused'); }
  joinRoom(): Promise<SessionInfo> { throw new Error('unused'); }
  reconnect(): Promise<SessionInfo> { throw new Error('unused'); }
  subscribe(_listener: (event: PokerClientEvent) => void): () => void { return () => {}; }

  send<Command extends PokerCommand>(
    command: Command,
    input: ClientCommandInput<Command>,
  ): Promise<ClientCommandData<Command>> {
    this.sent.push({ command, input });
    if (this.deferredCommands.has(command)) return new Promise(() => {});
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({} as ClientCommandData<Command>);
  }
}

function chatMessage(text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    kind: 'player',
    text,
    sentAt: 1_000,
    sender: { playerId: 'guest', nickname: '朋友', seatIndex: 3 },
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('poker table privacy and presentation', () => {
  it('renders nine fixed seats, public table state, blind markers, and only the viewer hand face up', () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);

    expect(screen.getAllByTestId(/^seat-/)).toHaveLength(9);
    expect(screen.getByText('总底池 750')).toBeInTheDocument();
    expect(screen.getByText('边池 150')).toBeInTheDocument();
    expect(screen.getByText('庄家')).toBeInTheDocument();
    expect(screen.getByText('小盲')).toBeInTheDocument();
    expect(screen.getByText('大盲')).toBeInTheDocument();
    const guestSeat = screen.getByTestId('seat-3');
    expect(within(guestSeat).getByText('朋友')).toBeInTheDocument();
    expect(within(guestSeat).getByText('筹码 2000')).toBeInTheDocument();
    expect(within(guestSeat).getByText('本街 200')).toBeInTheDocument();
    expect(within(guestSeat).getByText('加注')).toBeInTheDocument();
    expect(screen.getByLabelText('红桃 A')).toBeInTheDocument();
    expect(screen.getByLabelText('黑桃 K')).toBeInTheDocument();
    expect(screen.getByLabelText('方块 Q')).toBeInTheDocument();
    expect(screen.getAllByLabelText('底牌')).toHaveLength(4);
  });

  it('never places a face-down card rank or suit in DOM text or attributes', () => {
    const { container } = render(
      <PlayingCard faceDown card={{ rank: 14, suit: 'h' }} />,
    );

    expect(screen.getByLabelText('底牌')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/红桃|heart|rank|suit|14/i);
  });

  it('derives blind markers from players actually dealt into the current hand', () => {
    render(<PokerRoom
      client={new FakePokerClient()}
      view={viewWith({
        players: [
          player(),
          player({ id: 'busted', nickname: '零筹码', seatIndex: 1, stack: 0,
            isHost: false, holeCardCount: 0, holeCards: undefined }),
          player({ id: 'guest', nickname: '朋友', seatIndex: 3, isHost: false,
            holeCards: undefined }),
          player({ id: 'bot', nickname: '机器人', seatIndex: 7, isBot: true,
            isHost: false, holeCards: undefined }),
        ],
      })}
      playerId="me"
      connected
    />);

    expect(within(screen.getByTestId('seat-1')).queryByText('小盲')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('seat-3')).getByText('小盲')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-7')).getByText('大盲')).toBeInTheDocument();
  });
});

describe('server-authoritative action controls', () => {
  it('renders only server-allowed actions and sends a clamped raise-to total', async () => {
    const client = new FakePokerClient();
    render(<PokerRoom client={client} view={viewWith()} playerId="me" connected />);

    expect(screen.queryByRole('button', { name: '过牌' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^下注/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跟注 100' })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('加注到'));
    await userEvent.type(screen.getByLabelText('加注到'), '9999');
    await userEvent.click(screen.getByRole('button', { name: '加注到 2000' }));
    expect(client.sent).toContainEqual({
      command: 'game:act', input: { type: 'raise', amount: 2_000 },
    });
  });

  it('offers only valid pot shortcuts, changes the total input, and exposes the deadline', async () => {
    render(<ActionBar
      legalActions={{
        canFold: false, canCheck: true, canCall: false, canBet: true, canRaise: false,
        canAllIn: true, callAmount: 0, minRaiseTo: 100, maxRaiseTo: 700,
      }}
      potTotal={600}
      streetBet={0}
      deadline={Date.now() + 30_000}
      disabled={false}
      onAct={vi.fn().mockResolvedValue(undefined)}
    />);

    expect(screen.getByText(/剩余 \d+ 秒/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '半池 300' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3/4 池 450' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '3/4 池 450' }));
    expect(screen.getByLabelText('下注到')).toHaveValue(450);
  });

  it('disables the entire bar while disconnected or a command is pending', async () => {
    const disconnected = vi.fn();
    const { rerender } = render(<ActionBar
      legalActions={viewWith().legalActions!}
      potTotal={750}
      streetBet={100}
      deadline={Date.now() + 30_000}
      disabled
      onAct={disconnected}
    />);
    expect(screen.getByRole('group', { name: '玩家操作' })).toBeDisabled();

    let resolve!: () => void;
    const pending = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    rerender(<ActionBar
      legalActions={viewWith().legalActions!}
      potTotal={750}
      streetBet={100}
      deadline={Date.now() + 30_000}
      disabled={false}
      onAct={pending}
    />);
    await userEvent.click(screen.getByRole('button', { name: '弃牌' }));
    expect(screen.getByRole('group', { name: '玩家操作' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole('group', { name: '玩家操作' })).toBeEnabled());
  });
});

describe('chat and responsive drawers', () => {
  it('renders HTML-like chat as plain text and sends trimmed text', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatPanel
      messages={[chatMessage('<img src=x onerror=alert(1)>')]}
      onSend={onSend}
      disabled={false}
    />);

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    await userEvent.type(screen.getByLabelText('聊天消息'), '  大家好  ');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('大家好');
  });

  it('announces system, connection, waiting, and automatic-action notices', () => {
    render(<PokerRoom
      client={new FakePokerClient()}
      view={viewWith({
        waitingPosition: 2,
        messages: [chatMessage('朋友 超时，自动弃牌', { kind: 'system', sender: undefined })],
      })}
      playerId="me"
      connected={false}
      notice="消息发送太快，请稍后再试"
    />);

    expect(screen.getByText('连接已断开，操作和聊天暂不可用')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('当前等待位置：2')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('消息发送太快，请稍后再试')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('朋友 超时，自动弃牌')).toHaveAttribute('aria-live', 'polite');
  });

  it('announces a rejected chat command and keeps the unsent draft', async () => {
    const client = new FakePokerClient();
    client.failure = new Error('消息发送太快，请稍后再试');
    const onError = vi.fn();
    render(<PokerRoom
      client={client}
      view={viewWith()}
      playerId="me"
      connected
      onError={onError}
    />);

    await userEvent.type(screen.getByLabelText('聊天消息'), '请再试一次');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('消息发送太快，请稍后再试'));
    expect(screen.getByLabelText('聊天消息')).toHaveValue('请再试一次');
  });

  it('toggles the mobile action and chat drawers without hiding accessible actions', async () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);

    await userEvent.click(screen.getByRole('button', { name: '收起操作区' }));
    expect(screen.getByRole('button', { name: '展开操作区' })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: '展开操作区' }));
    expect(screen.getByRole('button', { name: '弃牌' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '打开聊天' }));
    expect(screen.getByRole('dialog', { name: '房间聊天' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭聊天' }));
    expect(screen.queryByRole('dialog', { name: '房间聊天' })).not.toBeInTheDocument();
  });

  it('lets the host start the first or next hand outside active play', async () => {
    const client = new FakePokerClient();
    render(<PokerRoom
      client={client}
      view={viewWith({ phase: 'lobby', actorId: undefined, legalActions: undefined })}
      playerId="me"
      connected
    />);

    await userEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    expect(client.sent).toContainEqual({ command: 'game:start', input: {} });
  });
});
