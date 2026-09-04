/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  leaveRoom(): Promise<void> { return Promise.resolve(); }
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

    expect(screen.getAllByTestId(/^seat-\d$/)).toHaveLength(9);
    expect(screen.getByText('总底池 750')).toBeInTheDocument();
    expect(screen.getByText('边池 150')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-0')).getByText('庄家')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-3')).getByText('小盲')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-7')).getByText('大盲')).toBeInTheDocument();
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

  it('keeps an independent viewer hand and complete public seat summaries for compact layouts', () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith({
      players: [
        player({ connected: false, allIn: true }),
        player({ id: 'guest', nickname: '朋友', seatIndex: 3, isHost: false,
          streetBet: 200, lastAction: 'raise', holeCards: undefined }),
        player({ id: 'bot', nickname: '机器人', seatIndex: 7, isBot: true,
          isHost: false, streetBet: 50, lastAction: 'fold', folded: true,
          holeCards: undefined }),
      ],
    })} playerId="me" connected />);

    const viewerHand = screen.getByRole('region', { name: '移动端我的手牌' });
    expect(viewerHand.closest('.table-seat')).toBeNull();
    expect(within(viewerHand).getByLabelText('红桃 A')).toBeInTheDocument();
    expect(within(viewerHand).getByLabelText('黑桃 K')).toBeInTheDocument();

    const meSummary = screen.getByTestId('seat-summary-0');
    expect(within(meSummary).getByText('已断线')).toBeInTheDocument();
    expect(within(meSummary).getByText('本街 100')).toBeInTheDocument();
    expect(within(meSummary).getByText('跟注')).toBeInTheDocument();
    expect(within(meSummary).getByText('庄家')).toBeInTheDocument();
    expect(within(meSummary).getByText('已全下')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-summary-3')).getByText('小盲')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-summary-7')).getByText('大盲')).toBeInTheDocument();
  });

  it('shows every server-authorized revealed hand and keeps absent hands face down', () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith({
      players: [
        player(),
        player({ id: 'revealed', nickname: '已摊牌', seatIndex: 3, isHost: false,
          holeCardCount: 0, holeCards: [{ rank: 2, suit: 's' }, { rank: 3, suit: 'd' }] }),
        player({ id: 'hidden', nickname: '未摊牌', seatIndex: 7, isHost: false,
          holeCards: undefined }),
      ],
    })} playerId="me" connected />);

    const revealed = screen.getByTestId('seat-3');
    expect(within(revealed).getByLabelText('黑桃 2')).toBeInTheDocument();
    expect(within(revealed).getByLabelText('方块 3')).toBeInTheDocument();
    expect(within(revealed).queryByLabelText('底牌')).not.toBeInTheDocument();
    expect(revealed.querySelector('.revealed-cards')).toBeInTheDocument();
    const hidden = screen.getByTestId('seat-7');
    expect(within(hidden).getAllByLabelText('底牌')).toHaveLength(2);
    expect(hidden.querySelector('.hidden-cards')).toBeInTheDocument();
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
    const slider = screen.getByLabelText('下注到滑块');
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '100');
    expect(slider).toHaveAttribute('max', '700');
    expect(slider).toHaveValue('450');
    fireEvent.change(slider, { target: { value: '625' } });
    expect(screen.getByLabelText('下注到')).toHaveValue(625);
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

  it('uses the server Unicode code-point limit so 300 emoji remain sendable', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatPanel messages={[]} onSend={onSend} disabled={false} />);
    const input = screen.getByLabelText('聊天消息');
    fireEvent.change(input, { target: { value: '😀'.repeat(301) } });

    expect(Array.from((input as HTMLTextAreaElement).value)).toHaveLength(300);
    expect(input).not.toHaveAttribute('maxlength');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('😀'.repeat(300));
  });

  it('scrolls to the newest message when a hidden drawer is revealed again', () => {
    const first = chatMessage('第一条');
    const { container, rerender } = render(
      <ChatPanel messages={[first]} onSend={vi.fn()} disabled={false} revealVersion={0} />,
    );
    const list = container.querySelector('.chat-messages') as HTMLDivElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    list.scrollTop = 40;
    fireEvent.scroll(list);

    rerender(<ChatPanel
      messages={[first, chatMessage('抽屉关闭时到达', { id: 2 })]}
      onSend={vi.fn()}
      disabled={false}
      revealVersion={0}
    />);
    expect(list.scrollTop).toBe(40);

    rerender(<ChatPanel
      messages={[first, chatMessage('抽屉关闭时到达', { id: 2 })]}
      onSend={vi.fn()}
      disabled={false}
      revealVersion={1}
    />);
    expect(list.scrollTop).toBe(400);

    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<ChatPanel
      messages={[
        first,
        chatMessage('抽屉关闭时到达', { id: 2 }),
        chatMessage('重开后到达', { id: 3 }),
      ]}
      onSend={vi.fn()}
      disabled={false}
      revealVersion={1}
    />);
    expect(list.scrollTop).toBe(500);
  });

  it('toggles the mobile action and chat drawers without hiding accessible actions', async () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);

    await userEvent.click(screen.getByRole('button', { name: '收起操作区' }));
    expect(screen.getByRole('button', { name: '展开操作区' })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: '展开操作区' }));
    expect(screen.getByRole('button', { name: '弃牌' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '打开移动聊天' }));
    expect(screen.getByRole('dialog', { name: '房间聊天' })).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: '房间聊天' });
    expect(within(dialog).getByRole('button', { name: '关闭聊天面板' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭聊天面板' }));
    expect(screen.queryByRole('dialog', { name: '房间聊天' })).not.toBeInTheDocument();
  });

  it('lets desktop users collapse and restore the right-side chat', async () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);
    const drawer = screen.getByTestId('chat-drawer');
    expect(drawer.parentElement).toHaveClass('chat-column');
    expect(within(drawer.parentElement!).getByRole('button', { name: '收起桌面聊天' }))
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起桌面聊天' }));
    expect(screen.getByRole('button', { name: '展开桌面聊天' })).toHaveAttribute('aria-expanded', 'false');
    expect(drawer).toHaveClass('desktop-closed');
    await userEvent.click(screen.getByRole('button', { name: '展开桌面聊天' }));
    expect(drawer).not.toHaveClass('desktop-closed');
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

  it('does not offer start when fewer than two seated players have chips', () => {
    render(<PokerRoom client={new FakePokerClient()} view={viewWith({
      phase: 'lobby',
      actorId: undefined,
      legalActions: undefined,
      players: [player(), player({ id: 'busted', nickname: '零筹码', seatIndex: 3,
        stack: 0, isHost: false, holeCardCount: 0, holeCards: undefined })],
    })} playerId="me" connected />);

    expect(screen.queryByRole('button', { name: '开始游戏' })).not.toBeInTheDocument();
  });
});
