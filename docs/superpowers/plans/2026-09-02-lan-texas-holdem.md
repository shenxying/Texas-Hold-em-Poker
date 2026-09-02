# 局域网私人德州扑克 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个在 `/home/sxy` 当前机器运行、支持私人房间、2–9 座真人/AI 混合牌局、虚拟筹码、实时聊天和局域网邀请的德州扑克 Web 应用。

**Architecture:** 使用 TypeScript 单仓库，纯函数牌局内核与网络层分离；Express/Socket.IO 服务端持有唯一权威状态，React/Vite 客户端只发送操作意图并渲染按会话脱敏的快照。房间、聊天和会话仅存内存，进程重启即清空。

**Tech Stack:** Node.js 24、TypeScript 5、Express 5、Socket.IO 4、React 19、Vite 7、Vitest、React Testing Library、Supertest。

**Spec:** `docs/superpowers/specs/2026-09-02-lan-texas-holdem-design.md`

## Global Constraints

- 只使用不可购买、不可提现、不可兑换的虚拟筹码，界面必须显示娱乐用途声明。
- 单桌 2–9 个座位；默认初始筹码 10,000，默认盲注 50/100。
- 服务端是牌局、下注、AI、计时和结算的唯一可信来源。
- 未摊牌的他人底牌、剩余牌堆和会话令牌不得进入客户端快照。
- 玩家行动限时 30 秒；断线保留座位 5 分钟。
- 聊天消息 1–300 字符，每会话 5 秒最多 5 条，每房间只保留最近 100 条。
- 服务监听 `0.0.0.0:3000`，不自动修改防火墙。
- 所有新增领域行为必须先看到对应测试因行为缺失而失败，再写生产实现。

---

## Planned File Structure

```text
lan-texas-holdem/
  package.json                       脚本与依赖
  .gitignore                         依赖、构建产物和本地日志忽略规则
  tsconfig.json                      双端 TypeScript 配置
  vite.config.ts                     前端构建与开发代理
  vitest.config.ts                   Node/jsdom 测试项目
  index.html                         Vite 入口
  src/
    shared/
      protocol.ts                    Socket 事件、错误与公开视图类型
    game/
      types.ts                       牌局内部类型
      cards.ts                       牌、牌堆和洗牌
      evaluator.ts                   七选五牌型比较
      betting.ts                     合法动作和下注轮推进
      pots.ts                        主池、边池、平分与结算
      engine.ts                      一手牌状态机
    server/
      room.ts                        房间、座位、会话和房主管理
      views.ts                       内部状态到玩家公开视图
      ai.ts                          三种 AI 风格决策
      chat.ts                        房间聊天与限流
      socket.ts                      Socket.IO 命令和广播
      timers.ts                      行动与断线计时
      app.ts                         Express/Socket.IO 应用工厂
      index.ts                       监听地址与局域网地址输出
    client/
      main.tsx                       React 入口
      App.tsx                        大厅/房间路由状态
      socket.ts                      类型化客户端与会话保存
      Lobby.tsx                      创建/加入房间
      PokerRoom.tsx                  牌桌页面编排
      PokerTable.tsx                 座位、公共牌与底池
      ActionBar.tsx                  合法操作与下注输入
      RoomControls.tsx               房主设置与 AI 管理
      ChatPanel.tsx                  聊天
      PlayingCard.tsx                扑克牌显示
      styles.css                     响应式视觉样式
  tests/
    cards-evaluator.test.ts
    betting-engine.test.ts
    pots-showdown.test.ts
    room-views.test.ts
    ai.test.ts
    chat.test.ts
    socket.integration.test.ts
    client-lobby.test.tsx
    client-table.test.tsx
  README.md
```

## Task 1: Toolchain, Cards, Deck, and Hand Evaluator

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `index.html`
- Create: `src/game/types.ts`
- Create: `src/game/cards.ts`
- Create: `src/game/evaluator.ts`
- Test: `tests/cards-evaluator.test.ts`

**Interfaces:**
- Produces: `type Card = { rank: Rank; suit: Suit }`
- Produces: `parseCard(text: string): Card`
- Produces: `createDeck(): Card[]`
- Produces: `shuffleDeck(deck: readonly Card[], randomInt: (max: number) => number): Card[]`
- Produces: `evaluateSeven(cards: readonly Card[]): HandRank`
- Produces: `compareHands(a: HandRank, b: HandRank): number`

- [ ] **Step 1: Add runnable TypeScript and test configuration**

Create `package.json` with ESM, scripts `dev`, `build`, `start`, `test`, `test:watch`, and dependencies installed by:

```bash
npm install express@5 socket.io@4 socket.io-client@4 react@19 react-dom@19
npm install -D typescript@5 vite@7 @vitejs/plugin-react@latest vitest@latest jsdom@latest @types/node@latest @types/express@latest @types/react@latest @types/react-dom@latest @testing-library/react@latest @testing-library/jest-dom@latest @testing-library/user-event@latest supertest@latest @types/supertest@latest tsx@latest concurrently@latest
```

Set scripts exactly to:

```json
{
  "dev": "tsx watch src/server/index.ts",
  "build": "vite build && tsc -p tsconfig.json --noEmit",
  "start": "NODE_ENV=production tsx src/server/index.ts",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Configure Vite to proxy `/socket.io` to `http://localhost:3000`, Vitest to include `tests/**/*.test.{ts,tsx}`, and TypeScript with `strict`, `noUncheckedIndexedAccess`, `jsx: react-jsx`, and path alias `@/* -> src/*`.

Create `.gitignore` with exactly `node_modules/`, `dist/`, `coverage/`, `*.log`, and `.env`. Client test files must begin with `// @vitest-environment jsdom`; all other tests use the default Node environment.

- [ ] **Step 2: Write the failing evaluator tests**

```ts
import { describe, expect, it } from 'vitest';
import { createDeck, parseCard, shuffleDeck } from '../src/game/cards';
import { compareHands, evaluateSeven } from '../src/game/evaluator';

const cards = (text: string) => text.split(' ').map(parseCard);

describe('cards and evaluator', () => {
  it('creates 52 unique cards and shuffles without mutating input', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, () => 0);
    expect(new Set(deck.map((c) => `${c.rank}${c.suit}`))).toHaveSize(52);
    expect(shuffled).not.toBe(deck);
    expect(deck).toEqual(createDeck());
  });

  it('orders every category and applies kickers', () => {
    const straightFlush = evaluateSeven(cards('As Ks Qs Js Ts 2d 3c'));
    const quads = evaluateSeven(cards('Ah Ad Ac As Kd 2c 3h'));
    const pairAce = evaluateSeven(cards('Ah Ad Kc Qs 9d 2c 3h'));
    const pairKing = evaluateSeven(cards('Kh Kd Ac Qs 9d 2c 3h'));
    expect(compareHands(straightFlush, quads)).toBeGreaterThan(0);
    expect(compareHands(pairAce, pairKing)).toBeGreaterThan(0);
  });

  it('recognizes a wheel straight with five high', () => {
    expect(evaluateSeven(cards('As 2d 3c 4h 5s Kd Qc'))).toMatchObject({
      category: 'straight',
      kickers: [5],
    });
  });
});
```

- [ ] **Step 3: Run the evaluator tests and verify RED**

Run: `npm test -- tests/cards-evaluator.test.ts`

Expected: FAIL because `src/game/cards.ts` and `src/game/evaluator.ts` do not exist.

- [ ] **Step 4: Implement immutable cards, Fisher–Yates shuffle, and seven-card evaluation**

Use these public types:

```ts
export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export interface Card { rank: Rank; suit: Suit }
export type HandCategory =
  | 'high-card' | 'pair' | 'two-pair' | 'trips'
  | 'straight' | 'flush' | 'full-house' | 'quads' | 'straight-flush';
export interface HandRank {
  category: HandCategory;
  categoryValue: number;
  kickers: number[];
  bestFive: Card[];
}
```

`parseCard` must accept `2`–`9`, `T`, `J`, `Q`, `K`, `A` plus `c/d/h/s`, reject malformed input, and `evaluateSeven` must require exactly seven unique cards. Enumerate all 21 five-card combinations, score each lexicographically by `[categoryValue, ...kickers]`, and retain the maximum.

- [ ] **Step 5: Run tests and type checking**

Run: `npm test -- tests/cards-evaluator.test.ts && npm run build`

Expected: evaluator tests PASS; Vite and TypeScript complete without errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.json vite.config.ts vitest.config.ts index.html src/game tests/cards-evaluator.test.ts
git commit -m "feat: add cards and hand evaluator"
```

## Task 2: Betting State Machine and Complete Hand Progression

**Files:**
- Create: `src/game/betting.ts`
- Create: `src/game/engine.ts`
- Modify: `src/game/types.ts`
- Test: `tests/betting-engine.test.ts`

**Interfaces:**
- Consumes: `Card`, `createDeck`, `shuffleDeck`, `evaluateSeven`
- Produces: `createHand(config: HandConfig): HandState`
- Produces: `getLegalActions(state: HandState, playerId: string): LegalActions`
- Produces: `applyAction(state: HandState, action: PlayerAction): HandTransition`
- Produces: `advanceAutomatic(state: HandState): HandTransition`

- [ ] **Step 1: Write failing tests for blinds, action order, legal amounts, and street progression**

```ts
import { describe, expect, it } from 'vitest';
import { applyAction, createHand, getLegalActions } from '../src/game/engine';

const seats = [
  { id: 'p1', stack: 10_000 },
  { id: 'p2', stack: 10_000 },
  { id: 'p3', stack: 10_000 },
];

describe('betting engine', () => {
  it('posts blinds and starts preflop left of the big blind', () => {
    const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    expect(state.players.map((p) => p.streetBet)).toEqual([0, 50, 100]);
    expect(state.actorId).toBe('p1');
    expect(getLegalActions(state, 'p1')).toMatchObject({ callAmount: 100, minRaiseTo: 200 });
  });

  it('moves to the flop only after every active player has matched and acted', () => {
    let state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'check' }).state;
    expect(state.street).toBe('flop');
    expect(state.board).toHaveLength(3);
    expect(state.actorId).toBe('p2');
  });

  it('does not reopen raising after an incomplete all-in raise', () => {
    const shortSeats = [{ id: 'p1', stack: 10_000 }, { id: 'p2', stack: 150 }, { id: 'p3', stack: 10_000 }];
    let state = createHand({ seats: shortSeats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
    state = applyAction(state, { playerId: 'p1', type: 'call' }).state;
    state = applyAction(state, { playerId: 'p2', type: 'all-in' }).state;
    state = applyAction(state, { playerId: 'p3', type: 'call' }).state;
    expect(getLegalActions(state, 'p1').canRaise).toBe(false);
  });
});
```

- [ ] **Step 2: Run the engine test and verify RED**

Run: `npm test -- tests/betting-engine.test.ts`

Expected: FAIL because `createHand` and action processing are missing.

- [ ] **Step 3: Implement exact engine state and action contracts**

```ts
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type PlayerAction =
  | { playerId: string; type: 'fold' | 'check' | 'call' | 'all-in' }
  | { playerId: string; type: 'bet' | 'raise'; amount: number };

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  callAmount: number;
  minRaiseTo: number | null;
  maxRaiseTo: number;
}

export interface HandTransition {
  state: HandState;
  events: GameEvent[];
}
```

Track per-player `stack`, `holeCards`, `streetBet`, `totalCommitted`, `folded`, `allIn`, `actedSinceFullRaise`, and `lastAction`. Track `currentBet`, `lastFullRaiseSize`, `actorId`, `dealerIndex`, board and deck. Clone arrays/objects on transition so callers cannot mutate prior snapshots.

Implement heads-up blind/order rules explicitly: dealer posts small blind, the other player posts big blind, dealer acts first preflop and big blind acts first after the flop. Reject wrong actor, negative/non-integer amounts, checks facing a bet, calls without a bet, and raises outside the legal range with stable error codes.

- [ ] **Step 4: Add one RED test per remaining transition edge**

Add separate tests for: everyone but one folds; all remaining players are all-in and board runs out; a player with less than a blind posts only their stack; postflop minimum opening bet equals big blind; a full raise reopens action; actor skips folded/all-in seats.

Run after adding each test: `npm test -- tests/betting-engine.test.ts`

Expected before the corresponding implementation: FAIL on the asserted state transition.

- [ ] **Step 5: Implement automatic progression and make all engine tests GREEN**

`advanceAutomatic` must repeatedly perform only deterministic work: award an uncontested hand, move to the next street when a round closes, deal 3/1/1 community cards, run out the board when no player can act, and stop at `showdown` for settlement. It must never choose a player action.

Run: `npm test -- tests/betting-engine.test.ts`

Expected: PASS.

- [ ] **Step 6: Run regression and commit**

```bash
npm test
npm run build
git add src/game tests/betting-engine.test.ts
git commit -m "feat: implement hold'em betting engine"
```

## Task 3: Main Pots, Side Pots, Showdown, and Odd Chips

**Files:**
- Create: `src/game/pots.ts`
- Modify: `src/game/engine.ts`
- Test: `tests/pots-showdown.test.ts`
- Test support: `tests/support/hands.ts`

**Interfaces:**
- Consumes: `HandState`, `evaluateSeven`, `compareHands`
- Produces: `buildPots(players: readonly HandPlayer[]): Pot[]`
- Produces: `settleShowdown(state: HandState): Settlement`
- Produces: `Settlement = { payouts: Record<string, number>; pots: SettledPot[]; revealedPlayerIds: string[] }`

- [ ] **Step 1: Write failing side-pot and tie tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildPots, settleShowdown } from '../src/game/pots';
import { handAtShowdown } from './support/hands';

describe('pots and showdown', () => {
  it('creates eligible side pots from unequal all-ins', () => {
    const pots = buildPots([
      { id: 'a', totalCommitted: 100, folded: false },
      { id: 'b', totalCommitted: 300, folded: false },
      { id: 'c', totalCommitted: 500, folded: false },
      { id: 'd', totalCommitted: 500, folded: true },
    ] as never);
    expect(pots).toEqual([
      { amount: 400, eligiblePlayerIds: ['a', 'b', 'c'] },
      { amount: 600, eligiblePlayerIds: ['b', 'c'] },
      { amount: 400, eligiblePlayerIds: ['c'] },
    ]);
  });

  it('splits ties and gives odd chips left of the dealer', () => {
    const state = handAtShowdown({ dealerIndex: 0, pot: 101, tiedPlayerIds: ['p1', 'p2'] });
    expect(settleShowdown(state).payouts).toEqual({ p1: 50, p2: 51 });
  });
});
```

Create `tests/support/hands.ts` only as a deterministic state builder; it must call production parsing/types and must not duplicate settlement logic.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/pots-showdown.test.ts`

Expected: FAIL because pot construction and settlement are missing.

- [ ] **Step 3: Implement contribution-layer pots and settlement**

For each ascending unique positive contribution level, subtract the previous level and multiply by every player who reached it. Folded chips remain in the amount but folded players are excluded from eligibility. Compare only eligible, non-folded hands for each pot. Distribute integer shares, then assign remainder one chip at a time by seat order beginning left of the dealer among that pot's winners.

- [ ] **Step 4: Integrate settlement into the engine**

When `advanceAutomatic` reaches showdown, call `settleShowdown`, update stacks exactly once, emit `hand-settled`, set street to `complete`, and retain only required revealed cards in settlement events. Add a test that calling `advanceAutomatic` again does not pay twice.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/pots-showdown.test.ts tests/betting-engine.test.ts
npm test
git add src/game tests/pots-showdown.test.ts tests/support/hands.ts
git commit -m "feat: settle main and side pots"
```

## Task 4: Rooms, Sessions, Seats, Host Transfer, and Private Views

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `src/server/room.ts`
- Create: `src/server/views.ts`
- Test: `tests/room-views.test.ts`
- Test support: `tests/support/rooms.ts`

**Interfaces:**
- Consumes: game engine state and transitions
- Produces: `RoomService.createRoom(input): JoinResult`
- Produces: `RoomService.joinRoom(input): JoinResult`
- Produces: `RoomService.reconnect(sessionToken): JoinResult`
- Produces: `RoomService.updateSettings(actorToken, patch): void`
- Produces: `RoomService.addBot(actorToken, style): void`
- Produces: `RoomService.removeBot(actorToken, playerId): void`
- Produces: `RoomService.disconnect(sessionToken, now): void`
- Produces: `RoomService.expireDisconnected(now): RoomEvent[]`
- Produces: `createTableView(room, viewerPlayerId): TableView`

- [ ] **Step 1: Write failing room lifecycle and privacy tests**

```ts
import { describe, expect, it } from 'vitest';
import { RoomService } from '../src/server/room';
import { createTableView } from '../src/server/views';

describe('room service and views', () => {
  it('creates a private room and rejects duplicate normalized nicknames', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: () => 'token-1' });
    const host = rooms.createRoom({ nickname: '小明' });
    expect(host.roomCode).toBe('ABCD23');
    expect(() => rooms.joinRoom({ roomCode: 'abcd23', nickname: ' 小明 ' }))
      .toThrowErrorMatchingObject({ code: 'NICKNAME_TAKEN' });
  });

  it('never includes another player hole cards in a private view', () => {
    const room = roomWithActiveHand();
    const view = createTableView(room, 'p1');
    expect(view.players.find((p) => p.id === 'p1')?.holeCards).toHaveLength(2);
    expect(view.players.find((p) => p.id === 'p2')?.holeCards).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('sessionToken');
    expect(JSON.stringify(view)).not.toContain('deck');
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/room-views.test.ts`

Expected: FAIL because room service and view projection do not exist.

- [ ] **Step 3: Define the shared protocol without internal state leakage**

```ts
export interface RoomSettings {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}
export type BotStyle = 'tight' | 'balanced' | 'aggressive';
export interface PublicPlayer {
  id: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  streetBet: number;
  connected: boolean;
  isBot: boolean;
  botStyle?: BotStyle;
  isHost: boolean;
  folded: boolean;
  allIn: boolean;
  lastAction?: string;
  holeCardCount: number;
  holeCards?: Card[];
}
export interface TableView {
  version: number;
  roomCode: string;
  settings: RoomSettings;
  phase: 'lobby' | 'playing' | 'between-hands';
  players: PublicPlayer[];
  board: Card[];
  pots: { amount: number }[];
  actorId?: string;
  dealerSeatIndex?: number;
  legalActions?: LegalActions;
  actionDeadline?: number;
  waitingPosition?: number;
  messages: ChatMessage[];
}
```

Keep `sessionToken`, deck, unrevealed cards, contribution internals and AI decision input out of these types.

- [ ] **Step 4: Implement room constraints and deterministic seat replacement**

Normalize nickname uniqueness with trim plus locale-independent lowercase. Validate 1–20 visible characters, room codes case-insensitively, starting stack 1,000–1,000,000, positive integer blinds, big blind >= small blind, and big blind <= starting stack. Use six characters from an unambiguous alphabet and retry on collision.

At 9 occupied seats, joining humans enter FIFO waiting only if a bot exists. At hand completion, remove bots starting with the highest seat index and seat waiting humans in FIFO order. Host-only methods throw `NOT_HOST`; settings and bot changes during a hand throw `HAND_IN_PROGRESS`.

- [ ] **Step 5: Add RED tests then implement reconnect, host transfer, and destruction**

Tests must assert: a new connection with the same token replaces the connection ID; disconnected humans retain seats before 300,000 ms; expiry removes them; host transfers to the earliest seated online human; a room with no humans is removed; zero-stack humans remain seated and can be reset only between hands by the host.

Run: `npm test -- tests/room-views.test.ts`

Expected: PASS after implementing these exact transitions.

- [ ] **Step 6: Regression and commit**

```bash
npm test
git add src/shared src/server/room.ts src/server/views.ts tests/room-views.test.ts tests/support
git commit -m "feat: add private rooms and player views"
```

## Task 5: Legal, Hidden-Information-Safe AI Players

**Files:**
- Create: `src/server/ai.ts`
- Test: `tests/ai.test.ts`
- Test support: `tests/support/bots.ts`

**Interfaces:**
- Consumes: `BotStyle`, `Card[]`, `LegalActions`, pot, position, action history, effective stack
- Produces: `BotInput` with no deck or opponent hole-card field
- Produces: `chooseBotAction(input: BotInput, random: () => number): PlayerAction`
- Produces: `botDelayMs(random: () => number): number`

- [ ] **Step 1: Write failing legality, hidden-information, style, and delay tests**

```ts
import { describe, expect, it } from 'vitest';
import { botDelayMs, chooseBotAction } from '../src/server/ai';

describe('poker bots', () => {
  it('always selects one of the supplied legal actions', () => {
    const input = botScenario({ style: 'balanced', legal: ['fold', 'call', 'all-in'] });
    expect(['fold', 'call', 'all-in']).toContain(chooseBotAction(input, () => 0.5).type);
  });

  it('uses only public state and its own cards', () => {
    const keys = Object.keys(botScenario({ style: 'tight' }));
    expect(keys).not.toContain('deck');
    expect(keys).not.toContain('opponentHoleCards');
  });

  it('keeps artificial thinking delay in the specified range', () => {
    expect(botDelayMs(() => 0)).toBe(600);
    expect(botDelayMs(() => 0.999)).toBeLessThanOrEqual(1800);
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/ai.test.ts`

Expected: FAIL because the bot policy is missing.

- [ ] **Step 3: Implement a bounded heuristic policy**

Calculate preflop strength from pair/high cards/suitedness/gap and postflop strength from `evaluateSeven` using only known cards. Combine normalized strength with position, `callAmount / (pot + callAmount)`, effective-stack-to-pot ratio, style thresholds, and injected random jitter. Map the score only to actions marked legal; choose check over fold when both represent no cost. Bet/raise sizes must be integer, clamped to `[minRaiseTo, maxRaiseTo]`, and use one of 0.5 pot, 0.75 pot or all-in based on style/score.

- [ ] **Step 4: Add fixed-scenario behavioral tests**

With fixed random values, assert tight folds a weak offsuit hand facing a large bet, all styles value-raise pocket aces when legal, aggressive raises a strong draw where tight calls, and no style returns a raise when `canRaise` is false.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/ai.test.ts
npm test
git add src/server/ai.ts tests/ai.test.ts tests/support
git commit -m "feat: add fair poker bot strategies"
```

## Task 6: Room Chat and System Messages

**Files:**
- Create: `src/server/chat.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/server/room.ts`
- Test: `tests/chat.test.ts`

**Interfaces:**
- Produces: `ChatService.send(roomId, sender, text, now): ChatMessage`
- Produces: `ChatService.system(roomId, text, now): ChatMessage`
- Produces: `ChatService.history(roomId): ChatMessage[]`
- Produces: `ChatMessage = { id; kind; text; sentAt; sender?: { playerId; nickname; seatIndex } }`

- [ ] **Step 1: Write failing validation, rate-limit, escaping-boundary, and history tests**

```ts
import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/server/chat';

describe('room chat', () => {
  it('trims messages, rejects empty/long text, and retains raw text as data', () => {
    const chat = new ChatService();
    expect(chat.send('r1', sender, '  <b>你好</b>  ', 1000).text).toBe('<b>你好</b>');
    expect(() => chat.send('r1', sender, ' '.repeat(3), 1001)).toThrowErrorMatchingObject({ code: 'INVALID_MESSAGE' });
    expect(() => chat.send('r1', sender, 'a'.repeat(301), 1002)).toThrowErrorMatchingObject({ code: 'INVALID_MESSAGE' });
  });

  it('allows five messages in five seconds and rejects the sixth', () => {
    const chat = new ChatService();
    for (let i = 0; i < 5; i += 1) chat.send('r1', sender, `m${i}`, 1000 + i);
    expect(() => chat.send('r1', sender, 'too fast', 1005)).toThrowErrorMatchingObject({ code: 'RATE_LIMITED' });
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/chat.test.ts`

Expected: FAIL because `ChatService` is missing.

- [ ] **Step 3: Implement per-session sliding-window limiting and capped history**

Use timestamps keyed by room and session, remove entries `<= now - 5000`, then reject when five remain. Append with monotonic IDs, cap each room array to the newest 100 via `slice(-100)`, and return cloned arrays. System messages bypass player rate limits but use the same history cap.

- [ ] **Step 4: Wire room domain events to Chinese system messages**

Translate joins, departures, host transfer, hand start, timeout action, bot add/remove and settlement into concise system messages. Do not include hole cards, tokens or stack internals beyond public payout summaries.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/chat.test.ts tests/room-views.test.ts
npm test
git add src/server/chat.ts src/server/room.ts src/shared/protocol.ts tests/chat.test.ts
git commit -m "feat: add rate-limited room chat"
```

## Task 7: Socket.IO Commands, Timers, Reconnect, and Multi-Client Sync

**Files:**
- Create: `src/server/timers.ts`
- Create: `src/server/socket.ts`
- Create: `src/server/app.ts`
- Test: `tests/socket.integration.test.ts`
- Test support: `tests/support/socket.ts`

**Interfaces:**
- Consumes: `RoomService`, `ChatService`, game engine, AI policy, view projection
- Produces: `createPokerServer(options): { httpServer; io; rooms; close(): Promise<void> }`
- Produces client commands: `room:create`, `room:join`, `room:reconnect`, `room:update-settings`, `room:add-bot`, `room:remove-bot`, `room:reset-stack`, `game:start`, `game:act`, `chat:send`
- Produces server events: `table:snapshot`, `command:error`, `session:replaced`

- [ ] **Step 1: Write a failing multi-client privacy and synchronization integration test**

```ts
it('synchronizes two clients without leaking private cards', async () => {
  const server = await startTestServer();
  const host = await connectClient(server.url);
  const guest = await connectClient(server.url);
  const created = await emitAck(host, 'room:create', { nickname: '房主' });
  await emitAck(guest, 'room:join', { roomCode: created.roomCode, nickname: '朋友' });
  await emitAck(host, 'game:start', {});
  const hostView = await nextSnapshot(host);
  const guestView = await nextSnapshot(guest);
  expect(hostView.players.find((p) => p.nickname === '房主').holeCards).toHaveLength(2);
  expect(hostView.players.find((p) => p.nickname === '朋友').holeCards).toBeUndefined();
  expect(guestView.players.find((p) => p.nickname === '朋友').holeCards).toHaveLength(2);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/socket.integration.test.ts`

Expected: FAIL because the Socket.IO application factory is missing.

- [ ] **Step 3: Implement validated command acknowledgements and per-viewer broadcast**

Every handler must return `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Resolve the session from socket data, call a room method, increment room `version`, then iterate connected sessions and emit a separately created `TableView`. Never use one shared view for a whole Socket.IO room.

- [ ] **Step 4: Add RED tests then implement action timers and bot scheduling**

Use injected scheduler methods `{ setTimeout, clearTimeout, now }`. Key one action timer by room and hand/version. At 30,000 ms, verify the same actor/version is still current, then auto-check if legal or auto-fold. For a bot actor, schedule exactly one action after `botDelayMs`; cancel it on any room transition or destruction.

Tests use fake timers and assert stale callbacks cannot act in a later hand.

- [ ] **Step 5: Add RED tests then implement reconnect and expiry**

On disconnect, mark the session offline and schedule expiry at 300,000 ms. `room:reconnect` with a valid token cancels expiry, binds the new socket, emits `session:replaced` to the old socket, and sends a full fresh snapshot. Expiry triggers host transfer/removal, waiting-player promotion if between hands, and room destruction when no humans remain.

- [ ] **Step 6: Add RED tests for illegal actions, chat, waiting humans, and full hand completion**

Drive real `socket.io-client` instances through: duplicate nickname rejection; non-host bot change rejection; legal action update on both clients; illegal double action rejected; six rapid messages limited; HTML-like chat remains text data; a human waits while nine seats include a bot and replaces it after settlement; mixed human/bot table completes a deterministic hand.

- [ ] **Step 7: Verify and commit**

```bash
npm test -- tests/socket.integration.test.ts
npm test
npm run build
git add src/server src/shared tests/socket.integration.test.ts tests/support
git commit -m "feat: add real-time poker server"
```

## Task 8: React Lobby, Session Restore, and Host Controls

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/socket.ts`
- Create: `src/client/App.tsx`
- Create: `src/client/Lobby.tsx`
- Create: `src/client/RoomControls.tsx`
- Create: `src/client/styles.css`
- Modify: `src/shared/protocol.ts`
- Test: `tests/client-lobby.test.tsx`

**Interfaces:**
- Consumes: typed Socket.IO commands and `TableView`
- Produces: `PokerClient` wrapper with `createRoom`, `joinRoom`, `reconnect`, `send`, `subscribe`
- Produces: lobby query parameter `room`
- Persists: `{ roomCode, sessionToken }` under localStorage key `lan-poker-session`

- [ ] **Step 1: Write failing lobby and session tests**

```tsx
it('creates a room from a valid nickname and displays the invitation', async () => {
  const client = fakePokerClient({ createRoom: { roomCode: 'ABCD23', sessionToken: 'secret' } });
  render(<App client={client} locationHref="http://192.168.1.8:3000/" />);
  await userEvent.type(screen.getByLabelText('昵称'), '小明');
  await userEvent.click(screen.getByRole('button', { name: '创建私人房间' }));
  expect(await screen.findByText('ABCD23')).toBeInTheDocument();
  expect(screen.getByDisplayValue('http://192.168.1.8:3000/?room=ABCD23')).toBeInTheDocument();
});

it('prefills room code from an invitation URL', () => {
  render(<App client={fakePokerClient()} locationHref="http://host/?room=ABCD23" />);
  expect(screen.getByLabelText('房间码')).toHaveValue('ABCD23');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/client-lobby.test.tsx`

Expected: FAIL because React entry and lobby are missing.

- [ ] **Step 3: Implement typed client, lobby, and restore behavior**

Validate visible nickname length before sending, uppercase room code, disable submit while awaiting acknowledgement, and show server error messages in an `aria-live="polite"` region. Generate invite URL from `new URL('/', locationHref)` and set only the `room` query parameter; never include session token. On startup, attempt saved-token reconnect once, clear invalid saved sessions, and leave nickname entry available.

- [ ] **Step 4: Add failing host-control tests and implement controls**

Tests assert only host sees editable starting stack/blinds, bot style selector, add/remove AI and reset-stack controls; all are disabled during a hand; invalid values show local help while server errors remain authoritative. Implement the exact ranges from the spec.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/client-lobby.test.tsx
npm test
git add src/client src/shared/protocol.ts tests/client-lobby.test.tsx
git commit -m "feat: add lobby and room controls"
```

## Task 9: Responsive Poker Table, Actions, Cards, and Chat UI

**Files:**
- Create: `src/client/PokerRoom.tsx`
- Create: `src/client/PokerTable.tsx`
- Create: `src/client/ActionBar.tsx`
- Create: `src/client/ChatPanel.tsx`
- Create: `src/client/PlayingCard.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Test: `tests/client-table.test.tsx`

**Interfaces:**
- Consumes: `TableView`, `LegalActions`, `ChatMessage`
- Produces: accessible buttons for fold/check/call/bet/raise/all-in
- Produces: bet/raise command amounts interpreted as total street amount (“加注到”)

- [ ] **Step 1: Write failing table privacy, seat, and action tests**

```tsx
it('renders only actions allowed by the server and sends raise-to amount', async () => {
  const client = fakePokerClient();
  render(<PokerRoom client={client} view={viewWith({
    actorId: 'me',
    legalActions: { canFold: true, canCheck: false, canCall: true, canBet: false,
      canRaise: true, canAllIn: true, callAmount: 100, minRaiseTo: 300, maxRaiseTo: 2000 },
  })} />);
  expect(screen.queryByRole('button', { name: '过牌' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '跟注 100' })).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('加注到'));
  await userEvent.type(screen.getByLabelText('加注到'), '600');
  await userEvent.click(screen.getByRole('button', { name: '加注到 600' }));
  expect(client.send).toHaveBeenCalledWith('game:act', { type: 'raise', amount: 600 });
});

it('renders HTML-like chat as plain text', () => {
  render(<ChatPanel messages={[message('<img src=x onerror=alert(1)>')]} onSend={() => {}} />);
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/client-table.test.tsx`

Expected: FAIL because table components are missing.

- [ ] **Step 3: Implement the desktop table and accessibility semantics**

Render nine fixed seat positions around an oval CSS grid, dealer/small-blind/big-blind markers, connection status text, stack, street bet, last action, board, total/side pots and own hole cards. `PlayingCard` must include spoken text such as `红桃 A`; face-down cards use `底牌` without hidden rank/suit in DOM attributes.

Action buttons use server `legalActions` only. Clamp numeric input, expose half-pot/three-quarter-pot/all-in quick buttons only when valid, show the action deadline countdown from server time, and disable the entire bar when disconnected or submitting.

- [ ] **Step 4: Implement chat, system messages, and connection banners**

Use ordinary React text interpolation, not `dangerouslySetInnerHTML`. Keep the newest message visible unless the user has scrolled upward. Display reconnection, replaced session, rate limit, waiting position and auto-check/fold notices with `aria-live` regions.

- [ ] **Step 5: Add mobile-layout assertions and responsive CSS**

At `max-width: 760px`, use a compact vertical table, horizontal seat-summary strip, bottom action drawer and toggleable chat drawer. Add component tests for both drawer toggles and ensure every action remains reachable by role/name independent of viewport.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/client-table.test.tsx tests/client-lobby.test.tsx
npm test
npm run build
git add src/client tests/client-table.test.tsx
git commit -m "feat: add responsive poker table and chat UI"
```

## Task 10: Production Serving, LAN Address Output, Documentation, and Acceptance

**Files:**
- Create: `src/server/index.ts`
- Modify: `src/server/app.ts`
- Modify: `vite.config.ts`
- Create: `README.md`
- Modify: `package.json`
- Test: `tests/socket.integration.test.ts`

**Interfaces:**
- Produces: `npm run dev` for Vite plus Socket server development
- Produces: `npm run build && npm start` for one-process LAN serving
- Produces: `GET /health` returning `{ ok: true }`

- [ ] **Step 1: Write a failing health/static-serving test**

```ts
it('serves health and the built SPA without exposing source state', async () => {
  const server = await startTestServer({ staticDir: fixtureDist });
  await request(server.httpServer).get('/health').expect(200, { ok: true });
  await request(server.httpServer).get('/').expect(200).expect('Content-Type', /html/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/socket.integration.test.ts`

Expected: FAIL because health/static routes are missing.

- [ ] **Step 3: Implement production entry and LAN discovery**

In production, serve `dist` with SPA fallback that excludes `/socket.io` and `/health`. Listen on `HOST ?? '0.0.0.0'` and integer `PORT ?? 3000`. Enumerate non-internal IPv4 addresses from `os.networkInterfaces()` and print each as `http://<address>:<port>`, plus `http://localhost:<port>` and a note that firewalls/client isolation may block access. Handle `SIGINT`/`SIGTERM` by closing timers, Socket.IO and HTTP server once.

For development, set `dev` exactly to `concurrently -k -n client,server "vite --host 0.0.0.0 --port 5173" "PORT=3000 tsx watch src/server/index.ts"`; keep the browser on Vite while `/socket.io` proxies to port 3000. Set `start` to `NODE_ENV=production tsx src/server/index.ts`; production requires a prior build and serves one port.

- [ ] **Step 4: Write complete Chinese README instructions**

Document these exact operator flows:

```bash
cd /home/sxy/lan-texas-holdem
npm install
npm run dev

npm test
npm run build
npm start
```

Explain how to use the printed `192.168.x.x:3000` address on devices connected to the same reachable LAN, how to create/copy an invite link, that mobile data/other Wi-Fi cannot reach it, and that corporate firewall/client isolation may require an allowed port. State that all chips are virtual, state is in memory, and restart clears rooms.

- [ ] **Step 5: Run automated acceptance verification**

Run:

```bash
npm test
npm run build
npm start
```

Expected: all Vitest projects PASS, TypeScript/Vite build succeeds, the server prints localhost and at least one available LAN address, `/health` returns HTTP 200, and no warning/error stack is printed during a two-client test hand.

- [ ] **Step 6: Perform proportional manual LAN smoke test**

From two browsers (and, when a second device is available, one phone on the same LAN): create a room, join by copied link, add one bot of each style, play through a hand including a raise and fold, send normal and HTML-like chat, refresh one browser and reconnect, let one action time out, and verify the phone layout exposes all actions. Record any environment-only limitation in README rather than silently changing firewall settings.

- [ ] **Step 7: Final regression and commit**

```bash
npm test
npm run build
git status --short
git add src/server/index.ts src/server/app.ts vite.config.ts package.json package-lock.json README.md tests/socket.integration.test.ts
git commit -m "docs: finish LAN poker app delivery"
```

Expected final repository state: clean worktree, all tests green, production build present or reproducible from the lockfile, and README sufficient for another person to start the app without additional context.
