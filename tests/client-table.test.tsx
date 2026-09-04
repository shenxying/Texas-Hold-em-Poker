/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function cockpitProps(): {
  inviteUrl: string;
  leaving: boolean;
  onLeave: () => Promise<void>;
  onError: (message: string) => void;
} {
  return {
    inviteUrl: 'http://host/poker/?room=ABCD23',
    leaving: false,
    onLeave: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('cockpit CSS contract', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/client/styles.css'), 'utf8');

  it('uses a bounded viewport shell with shrinkable stage and layered dock', () => {
    expect(css).toMatch(/\.room-cockpit\s*\{[^}]*height:\s*100dvh/s);
    expect(css).toMatch(/\.table-stage\s*\{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.player-dock\s*\{[^}]*z-index:/s);
    expect(css).toMatch(/\.room-side-panel\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).not.toMatch(/\.action-drawer\s*\{/);
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.room-cockpit\s*\{[^}]*flex-direction:\s*column/s);
  });
});

describe('poker table privacy and presentation', () => {
  it('renders nine fixed seats, public table state, blind markers, and only the viewer hand face up', () => {
    render(<PokerRoom {...cockpitProps()} client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);

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
    const dock = screen.getByRole('region', { name: '我的手牌和操作' });
    expect(within(dock).getByLabelText('红桃 A')).toBeInTheDocument();
    expect(within(dock).getByLabelText('黑桃 K')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /红桃 A|黑桃 K/ })).toHaveLength(2);
    expect(within(screen.getByTestId('seat-0')).queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('.viewer-hand')).toBeNull();
    expect(document.querySelector('.action-drawer')).toBeNull();
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
      {...cockpitProps()}
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

  it('does not mark empty seats as the actor when no turn is active', () => {
    render(<PokerRoom
      {...cockpitProps()}
      client={new FakePokerClient()}
      view={viewWith({ phase: 'lobby', actorId: undefined, legalActions: undefined })}
      playerId="me"
      connected
    />);

    expect(document.querySelectorAll('.table-seat.current-actor')).toHaveLength(0);
  });

  it('keeps an independent viewer hand and complete public seat summaries for compact layouts', () => {
    render(<PokerRoom {...cockpitProps()} client={new FakePokerClient()} view={viewWith({
      players: [
        player({ connected: false, allIn: true }),
        player({ id: 'guest', nickname: '朋友', seatIndex: 3, isHost: false,
          streetBet: 200, lastAction: 'raise', holeCards: undefined }),
        player({ id: 'bot', nickname: '机器人', seatIndex: 7, isBot: true,
          isHost: false, streetBet: 50, lastAction: 'fold', folded: true,
          holeCards: undefined }),
      ],
    })} playerId="me" connected />);

    const dock = screen.getByRole('region', { name: '我的手牌和操作' });
    expect(dock.closest('.table-seat')).toBeNull();
    expect(within(dock).getByLabelText('红桃 A')).toBeInTheDocument();
    expect(within(dock).getByLabelText('黑桃 K')).toBeInTheDocument();

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
    render(<PokerRoom {...cockpitProps()} client={new FakePokerClient()} view={viewWith({
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
    render(<PokerRoom {...cockpitProps()} client={client} view={viewWith()} playerId="me" connected />);

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
      {...cockpitProps()}
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
      {...cockpitProps()}
      client={client}
      view={viewWith()}
      playerId="me"
      connected
      onError={onError}
    />);

    await userEvent.click(screen.getByRole('button', { name: '聊天' }));
    await userEvent.type(screen.getByLabelText('聊天消息'), '请再试一次');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('消息发送太快，请稍后再试'));
    expect(screen.getByLabelText('聊天消息')).toHaveValue('请再试一次');
    await userEvent.click(screen.getByRole('button', { name: '关闭侧边栏' }));
    await userEvent.click(screen.getByRole('button', { name: '聊天' }));
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

  it('opens the host side panel directly to chat or settings, switches tabs, and closes it', async () => {
    render(<PokerRoom {...cockpitProps()} client={new FakePokerClient()} view={viewWith()} playerId="me" connected />);
    const panel = screen.getByTestId('room-side-panel');
    expect(panel).toHaveAttribute('hidden');

    const chatTrigger = screen.getByRole('button', { name: '聊天' });
    await userEvent.click(chatTrigger);
    expect(chatTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('button', { name: '房主设置' }));
    expect(screen.getByRole('tab', { name: '房主设置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('初始筹码')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '聊天' }));
    expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: '关闭侧边栏' }));
    expect(panel).toHaveAttribute('hidden');
    expect(chatTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(chatTrigger).toHaveFocus();
  });

  it('turns the narrow-screen panel into a modal drawer and restores its trigger on Escape', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(<PokerRoom
      {...cockpitProps()}
      client={new FakePokerClient()}
      view={viewWith({ phase: 'lobby', actorId: undefined, legalActions: undefined })}
      playerId="me"
      connected
    />);

    const trigger = screen.getByRole('button', { name: '聊天' });
    await userEvent.click(trigger);
    const drawer = screen.getByRole('dialog', { name: '房间侧边栏' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.room-header')).toHaveAttribute('inert');
    expect(document.querySelector('.table-stage')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '关闭侧边栏' })).toHaveFocus();

    const first = screen.getByRole('tab', { name: '聊天' });
    const message = screen.getByLabelText('聊天消息');
    await userEvent.type(message, '循环焦点');
    const last = screen.getByRole('button', { name: '发送' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    await userEvent.click(screen.getByRole('tab', { name: '房主设置' }));
    const settingsFirst = screen.getByRole('tab', { name: '房主设置' });
    const settingsLast = screen.getByRole('button', { name: '移除 机器人' });
    settingsFirst.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(settingsLast).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(settingsFirst).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(drawer).toHaveAttribute('hidden'));
    expect(document.querySelector('.room-header')).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '房主设置' })).toHaveFocus();
  });

  it('never exposes host settings to a guest', async () => {
    render(<PokerRoom
      {...cockpitProps()}
      client={new FakePokerClient()}
      view={viewWith({ players: viewWith().players.map((current) => (
        current.id === 'me' ? { ...current, isHost: false } : current
      )) })}
      playerId="me"
      connected
    />);

    expect(screen.queryByRole('button', { name: '房主设置' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '聊天' }));
    expect(screen.queryByRole('tab', { name: '房主设置' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('初始筹码')).not.toBeInTheDocument();
  });

  it('lets the host start the first or next hand outside active play', async () => {
    const client = new FakePokerClient();
    render(<PokerRoom
      {...cockpitProps()}
      client={client}
      view={viewWith({ phase: 'lobby', actorId: undefined, legalActions: undefined })}
      playerId="me"
      connected
    />);

    await userEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    expect(client.sent).toContainEqual({ command: 'game:start', input: {} });
  });

  it('does not offer start when fewer than two seated players have chips', () => {
    render(<PokerRoom {...cockpitProps()} client={new FakePokerClient()} view={viewWith({
      phase: 'lobby',
      actorId: undefined,
      legalActions: undefined,
      players: [player(), player({ id: 'busted', nickname: '零筹码', seatIndex: 3,
        stack: 0, isHost: false, holeCardCount: 0, holeCards: undefined })],
    })} playerId="me" connected />);

    expect(screen.queryByRole('button', { name: '开始游戏' })).not.toBeInTheDocument();
  });
});
