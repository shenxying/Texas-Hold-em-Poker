# Poker Room UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add confirmed immediate room exit and rebuild the poker client as a comfortable one-screen desktop cockpit with a true home screen, host settings in a side panel, and an unobstructed viewer hand.

**Architecture:** Add a non-turn forceFold game transition, then compose it with permanent membership removal in the Socket.IO room:leave command. On the client, make the socket client own recovery cleanup, keep browser-session reset in App, and split the room UI into a header, tabbed side panel, table-only center stage, and fixed player dock. CSS owns the viewport contract; an isolated Playwright run on ports 3410/3411 verifies actual 1366×768 geometry without touching the shared 8080 service.

**Tech Stack:** TypeScript 5.9, React 19, Socket.IO 4, Vitest 4, Testing Library, Vite 7, Playwright Chromium, CSS Grid/Flexbox.

**Spec:** docs/superpowers/specs/2026-09-04-poker-room-ux-redesign-design.md

## Global Constraints

- Virtual chips remain entertainment-only; never add payment, top-up, withdrawal, or exchange features.
- Preserve private room codes, invite URLs, AI players, chat, reconnect behavior, betting rules, and /poker/ deployment compatibility.
- Do not modify the Drawing API, shared gateway topology, firewall, or exposed-port configuration.
- Do not stop, start, restart, signal, or reconfigure any live service while implementing or testing this plan.
- Automated network tests bind only ephemeral ports, except isolated browser ports 127.0.0.1:3410 and 127.0.0.1:3411; a conflict must fail rather than kill a listener.
- At 1366×768 the room document must not vertically scroll; message lists and side panels may scroll internally.
- The viewer's exposed hole cards render exactly once, inside the player dock, above all table content.
- Every behavior change follows RED → GREEN → REFACTOR and every task receives focused review before the next task.

---

### Task 1: Add an out-of-turn forced-fold transition

**Files:**
- Modify: src/game/engine.ts
- Modify: src/game/types.ts
- Test: tests/betting-engine.test.ts

**Interfaces:**
- Consumes: immutable HandState, advanceAutomatic, GameRuleError, GameEvent, and HandTransition.
- Produces: forceFold(input: HandState, playerId: string): HandTransition from src/game/engine.ts.
- Guarantees: input is not mutated; a live player can fold when not the actor; actor selection, automatic progression, uncontested award, and showdown remain valid.

- [ ] **Step 1: Write failing forced-fold tests**

Add these behaviors to tests/betting-engine.test.ts:

~~~ts
it('force-folds a non-actor without changing the current actor', () => {
  const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
  const leaving = state.players.find((player) => player.id !== state.actorId)!.id;
  const transition = forceFold(state, leaving);
  expect(transition.state.players.find((player) => player.id === leaving)).toMatchObject({
    folded: true,
    lastAction: 'fold',
  });
  expect(transition.state.actorId).toBe(state.actorId);
  expect(state.players.find((player) => player.id === leaving)!.folded).toBe(false);
});

it('force-folds the actor and advances to the next eligible player', () => {
  const state = createHand({ seats, dealerIndex: 0, smallBlind: 50, bigBlind: 100 });
  const transition = forceFold(state, state.actorId!);
  expect(transition.state.actorId).not.toBe(state.actorId);
  expect(transition.events).toContainEqual({
    type: 'player-acted', action: { playerId: state.actorId, type: 'fold' },
  });
});
~~~

Also cover a two-player uncontested settlement, unknown player, already-folded idempotence, and all-in forced forfeiture so explicit leave is deterministic.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

~~~bash
npx vitest run tests/betting-engine.test.ts
~~~

Expected: FAIL because forceFold is not exported.

- [ ] **Step 3: Implement forceFold with shared progression**

Extract post-action actor/automatic progression from applyAction into a private helper. Implement the public shape:

~~~ts
export function forceFold(input: HandState, playerId: string): HandTransition {
  const state = cloneState(input);
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) throw new GameRuleError('UNKNOWN_PLAYER', 'Player does not exist');
  const player = state.players[playerIndex]!;
  if (state.street === 'complete') {
    throw new GameRuleError('HAND_NOT_ACTIVE', 'The hand is not active');
  }
  if (player.folded) return { state, events: [] };
  player.folded = true;
  player.lastAction = 'fold';
  player.actedSinceFullRaise = true;
  return finishPlayerAction(
    state,
    playerIndex,
    [{ type: 'player-acted', action: { playerId, type: 'fold' } }],
    input.actorId === playerId,
  );
}
~~~

finishPlayerAction retains a still-eligible current actor for a non-actor fold, chooses the next eligible actor when the actor leaves, and always invokes advanceAutomatic.

- [ ] **Step 4: Verify engine and settlement tests**

~~~bash
npx vitest run tests/betting-engine.test.ts tests/pots-showdown.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

~~~bash
git add src/game/engine.ts src/game/types.ts tests/betting-engine.test.ts
git commit -m "feat: support forced fold on room exit"
~~~

---

### Task 2: Centralize permanent room membership removal

**Files:**
- Modify: src/server/room.ts
- Test: tests/room-views.test.ts
- Test: tests/chat.test.ts

**Interfaces:**
- Consumes: requireSession, RoomEvent, promoteWaiting, chat system events, and five-minute disconnect expiry.
- Produces: RoomService.leave(sessionToken: string, now: number): RoomEvent[].
- Guarantees: session removal is immediate; host goes to the earliest-joined connected human; bots never become host; AI-only rooms are destroyed; expiry shares the same cleanup path.

- [ ] **Step 1: Write failing room-service tests**

Cover seated guest, waiting guest, host transfer, waiter promotion between hands, final-human destruction, invalidated reconnect, and chat cleanup:

~~~ts
const events = rooms.leave(host.sessionToken, 1_000);
expect(events).toContainEqual({
  type: 'player-left', roomCode: host.roomCode, playerId: host.playerId,
});
expect(rooms.getRoom(host.roomCode)!.hostPlayerId).toBe(guest.playerId);
expect(() => rooms.reconnect(host.sessionToken)).toThrowError('Session does not exist');
~~~

Preserve all existing expireDisconnected expectations.

- [ ] **Step 2: Run room/chat tests and verify RED**

~~~bash
npx vitest run tests/room-views.test.ts tests/chat.test.ts
~~~

Expected: FAIL because RoomService.leave is absent.

- [ ] **Step 3: Extract one removal path**

Add:

~~~ts
private removeHuman(
  sessionToken: string,
  room: Room,
  player: RoomPlayer,
  now: number,
): RoomEvent[]
~~~

It deletes the session, removes the exact player object from seats or waiting, records player-left, clears host ownership, destroys no-human rooms and chat, promotes waiters only outside playing, and transfers host by joinedOrder. Public leave uses requireSession plus this helper. expireDisconnected selects only expired records, then invokes the same helper.

- [ ] **Step 4: Verify room/chat tests**

~~~bash
npx vitest run tests/room-views.test.ts tests/chat.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

~~~bash
git add src/server/room.ts tests/room-views.test.ts tests/chat.test.ts
git commit -m "feat: remove players explicitly from rooms"
~~~

---

### Task 3: Expose room:leave and clear client recovery

**Files:**
- Modify: src/shared/protocol.ts
- Modify: src/server/socket.ts
- Modify: src/client/socket.ts
- Test: tests/socket.integration.test.ts
- Test: tests/client-socket.test.tsx

**Interfaces:**
- Consumes: Task 1 forceFold, Task 2 RoomService.leave, socket identity, timers, finishHandIfNeeded, scheduleNextAction, and broadcast.
- Produces: typed room:leave with empty input/result and PokerClient.leaveRoom(localOnly?: boolean): Promise<void>.
- Guarantees: connected leave folds before removal, cancels stale expiry, clears socket binding, and broadcasts once; local-only leave sends nothing and prevents later automatic reconnect.

- [ ] **Step 1: Write failing Socket.IO integration tests**

Cover waiting leave, between-hand host leave, non-actor and actor active-hand leave, last-human-with-bots leave, and duplicate leave:

~~~ts
await emitAck(leaver, 'room:leave', {});
const snapshot = await nextSnapshot(
  remaining,
  (view) => !view.players.some((player) => player.id === leaverSession.playerId),
);
expect(snapshot.actorId).not.toBe(leaverSession.playerId);
await expect(emitAck(leaver, 'room:leave', {}))
  .rejects.toMatchObject({ code: 'INVALID_SESSION' });
~~~

Assert committed chips remain in the hand/pot after forced fold and host transfer appears in the resulting snapshot.

- [ ] **Step 2: Write failing socket-client tests**

Prove successful leave emits room:leave, clears recovery, and reconnect emits no room:reconnect. Prove leaveRoom(true) sends nothing, while a rejected connected leave retains binding so recovery still works.

- [ ] **Step 3: Run focused tests and verify RED**

~~~bash
npx vitest run tests/socket.integration.test.ts tests/client-socket.test.tsx
~~~

Expected: FAIL because the command and client method are absent.

- [ ] **Step 4: Implement protocol and server orchestration**

Add:

~~~ts
'room:leave': (
  input: Record<string, never>,
  ack: CommandAck<Record<string, never>>,
) => void;
~~~

Extract mutation-only hand commit into:

~~~ts
function commitHandTransition(
  room: Room,
  transition: HandTransition,
  historyAction?: PlayerAction,
): void
~~~

The leave handler uses recordInput and rejects any own keys with INVALID_INPUT, resolves current(socket), clears the disconnect timer, calls forceFold for an unfolded hand player, calls rooms.leave, clears socket.data room/session/player fields, and invokes void socket.leave(room.code). If the room survives, increment version after all mutations, reschedule, and broadcast once. If destroyed, clear action timer, scheduled turn, and action history.

- [ ] **Step 5: Implement client leave cleanup**

~~~ts
async leaveRoom(localOnly = false): Promise<void> {
  if (!localOnly) await this.send('room:leave', {});
  this.boundSession = undefined;
  this.recovery = undefined;
  this.replaced = false;
}
~~~

Do not clear boundSession before a connected leave succeeds. Keep the transport connected so the tab can create or join again.

- [ ] **Step 6: Verify integrated leave behavior**

~~~bash
npx vitest run tests/socket.integration.test.ts tests/client-socket.test.tsx tests/room-views.test.ts tests/betting-engine.test.ts
~~~

Expected: PASS with no leaked timers or sockets.

- [ ] **Step 7: Commit Task 3**

~~~bash
git add src/shared/protocol.ts src/server/socket.ts src/client/socket.ts tests/socket.integration.test.ts tests/client-socket.test.tsx
git commit -m "feat: leave poker rooms safely"
~~~

---

### Task 4: Add home navigation and confirmed leave

**Files:**
- Create: src/client/RoomHeader.tsx
- Create: src/client/LeaveRoomDialog.tsx
- Modify: src/client/App.tsx
- Modify: src/client/Lobby.tsx
- Test: tests/client-lobby.test.tsx

**Interfaces:**
- Consumes: PokerClient.leaveRoom, SessionInfo, TableView, connection state, invite generation, storage/history, and the existing PokerRoom.
- Produces: a room header above the existing PokerRoom and an alert dialog with onCancel(): void, onConfirm(): Promise<void>, playing: boolean, pending: boolean. Task 5 later extends and moves the header into the cockpit compositor.
- Guarantees: first click never leaves; Cancel is initially focused; confirm sends once; success clears session/storage and only the room query; failure stays in room; disconnected confirm is local-only.

- [ ] **Step 1: Write failing dialog/navigation tests**

Enter a room, publish a playing view, click Exit once, and assert:

~~~ts
const trigger = screen.getByRole('button', { name: '退出房间' });
await userEvent.click(trigger);
const dialog = screen.getByRole('alertdialog', { name: '确认退出房间' });
expect(within(dialog).getByText('退出将立即弃牌并离开房间。')).toBeInTheDocument();
expect(client.leaveRoom).not.toHaveBeenCalled();
expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
~~~

Add cancel/focus restoration, pending double-click, success cleanup, rejection preservation, lobby copy, and disconnected leaveRoom(true). With jsdom at /poker/?room=ABCD23&keep=yes, successful leave must produce /poker/?keep=yes.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run tests/client-lobby.test.tsx
~~~

Expected: FAIL because header, dialog, and reset are absent.

- [ ] **Step 3: Implement accessible dialog and header**

LeaveRoomDialog uses role=alertdialog, labelled title/description, Escape-to-cancel while idle, a mount effect focusing Cancel, and a destructive confirm button. RoomHeader receives:

~~~ts
interface RoomHeaderProps {
  roomCode: string;
  inviteUrl: string;
  connected: boolean;
  playing: boolean;
  leaving: boolean;
  onLeave(): Promise<void>;
}
~~~

Copy with navigator.clipboard.writeText when available and announce success/failure in an aria-live status. Display the room code without a full-width URL input. App renders this header immediately above the existing PokerRoom so Task 4 is independently usable and testable.

- [ ] **Step 4: Implement App reset boundary and home**

App clears savedSession.current, localStorage, session, view, and error only after leave succeeds. Remove only room from the URL via history.replaceState. Call client.leaveRoom(connectionState !== 'connected'). Enhance Lobby into a clear home card with one shared nickname, separate Create and Join actions, and stable restore/validation feedback. Keep RoomControls in its current page position until Task 5 moves it into the side panel.

- [ ] **Step 5: Verify home/leave tests**

~~~bash
npx vitest run tests/client-lobby.test.tsx
~~~

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

~~~bash
git add src/client/App.tsx src/client/Lobby.tsx src/client/RoomHeader.tsx src/client/LeaveRoomDialog.tsx tests/client-lobby.test.tsx
git commit -m "feat: add confirmed room exit navigation"
~~~

---

### Task 5: Compose table, side panel, and player dock

**Files:**
- Create: src/client/RoomSidePanel.tsx
- Create: src/client/PlayerDock.tsx
- Modify: src/client/PokerRoom.tsx
- Modify: src/client/PokerTable.tsx
- Modify: src/client/RoomControls.tsx
- Modify: src/client/ActionBar.tsx
- Test: tests/client-table.test.tsx

**Interfaces:**
- Consumes: Task 4 RoomHeader, ChatPanel, RoomControls, legalActions, TableView, and PublicPlayer.holeCards.
- Produces: tabbed RoomSidePanel and PlayerDock with viewer cards, stack/turn context, start action, countdown, and ActionBar.
- Guarantees: viewer cards render exactly once in the dock; Settings is host-only; top controls open the selected tab; old sticky action and permanent chat columns disappear.

PokerRoom's completed compositor interface is:

~~~ts
interface PokerRoomProps {
  client: PokerClient;
  view: TableView;
  playerId: string;
  inviteUrl: string;
  connected: boolean;
  leaving: boolean;
  onLeave(): Promise<void>;
  onError(message: string): void;
}
~~~

- [ ] **Step 1: Write failing cockpit tests**

~~~ts
const dock = screen.getByRole('region', { name: '我的手牌和操作' });
expect(within(dock).getByLabelText('红桃 A')).toBeInTheDocument();
expect(within(dock).getByLabelText('黑桃 K')).toBeInTheDocument();
expect(screen.getAllByRole('img', { name: /红桃 A|黑桃 K/ })).toHaveLength(2);
expect(document.querySelector('.action-drawer')).toBeNull();
~~~

Also test opening Chat and Host Settings, tab switching, close, guest hiding Settings, chat error/draft preservation, and existing start/action commands.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run tests/client-table.test.tsx
~~~

Expected: FAIL because cockpit components are absent.

- [ ] **Step 3: Implement PlayerDock**

~~~ts
interface PlayerDockProps {
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  onError(message: string): void;
}
~~~

Render role=region and aria-label=我的手牌和操作. Show the viewer's exposed cards, stack and turn text, start action for an eligible host, and ActionBar only for legal actor actions. PokerTable never invokes SeatCards for playerId and no longer renders viewer-hand.

- [ ] **Step 4: Implement RoomSidePanel**

~~~ts
export type RoomPanelTab = 'chat' | 'settings';

interface RoomSidePanelProps {
  openTab: RoomPanelTab | null;
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  chatRevealVersion: number;
  onClose(): void;
  onSelect(tab: RoomPanelTab): void;
  onError(message: string): void;
}
~~~

Use tablist/tab/tabpanel semantics. Render Settings only for a host. Keep RoomControls validation/commands intact and ChatPanel internally scrollable.

- [ ] **Step 5: Recompose PokerRoom**

Extend RoomHeader with isHost and onOpenPanel(tab: RoomPanelTab), then move it from App into PokerRoom. App passes inviteUrl, leaving, and onLeave through the completed PokerRoom interface above. PokerRoom owns openTab and chat reveal version. Render RoomHeader, notices, table-stage with PokerTable, PlayerDock, and RoomSidePanel. Opening a previously closed Chat increments reveal version. Remove actionsOpen, mobileChatOpen, desktopChatOpen, action-drawer, chat-column, and their toggle labels.

- [ ] **Step 6: Verify client suites**

~~~bash
npx vitest run tests/client-table.test.tsx tests/client-lobby.test.tsx
~~~

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

~~~bash
git add src/client/RoomSidePanel.tsx src/client/PlayerDock.tsx src/client/PokerRoom.tsx src/client/PokerTable.tsx src/client/RoomControls.tsx src/client/ActionBar.tsx tests/client-table.test.tsx
git commit -m "feat: compose the poker table cockpit"
~~~

---

### Task 6: Apply the visual system and verify 1366×768 geometry

**Files:**
- Modify: src/client/styles.css
- Modify: vite.config.ts
- Modify: package.json
- Modify: package-lock.json
- Create: playwright.config.ts
- Create: tests/layout.e2e.ts
- Test: tests/client-table.test.tsx
- Test: tests/client-lobby.test.tsx

**Interfaces:**
- Consumes: Task 5 semantic classes and accessible controls.
- Produces: fixed desktop shell, responsive table, bounded side panel, layered dock, refreshed home, compact-height rules, and npm run test:e2e.
- Guarantees: no document scroll at 1366×768 before/after Chat/Settings; dock/cards remain in viewport; mobile drawers scroll internally.

- [ ] **Step 1: Add failing CSS contract tests**

Read src/client/styles.css in Vitest and assert:

~~~ts
expect(css).toMatch(/\\.room-cockpit\\s*\\{[^}]*height:\\s*100dvh/s);
expect(css).toMatch(/\\.table-stage\\s*\\{[^}]*min-height:\\s*0/s);
expect(css).toMatch(/\\.player-dock\\s*\\{[^}]*z-index:/s);
expect(css).not.toMatch(/\\.action-drawer\\s*\\{/);
~~~

- [ ] **Step 2: Run component tests and verify RED**

~~~bash
npx vitest run tests/client-table.test.tsx tests/client-lobby.test.tsx
~~~

Expected: FAIL on the new CSS contract.

- [ ] **Step 3: Implement the cockpit visual system**

Use felt green, warm ivory, muted gold, and danger red. Required structure:

~~~css
html, body, #root { min-width: 320px; min-height: 100%; }
@media (min-width: 761px) {
  body:has(.room-cockpit) { overflow: hidden; }
  .room-cockpit {
    width: 100%;
    height: 100dvh;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow: hidden;
  }
  .table-stage { min-width: 0; min-height: 0; overflow: hidden; }
  .poker-table {
    width: min(100%, calc((100dvh - 15rem) * 1.72));
    aspect-ratio: 1.72;
  }
  .room-side-panel { min-height: 0; overflow: hidden; }
  .player-dock { position: relative; z-index: 20; }
}
~~~

Add max-height:820px compact rules with clamp. Keep primary actions at least 40px. On mobile, use a fixed side panel with internal overflow, keep the dock sticky, and allow document scrolling only when physical height is insufficient. Add reduced-motion overrides.

- [ ] **Step 4: Add Playwright on isolated ports**

~~~bash
npm install --save-dev @playwright/test
npx playwright install chromium
~~~

Add test:e2e = playwright test. Let vite.config.ts read VITE_SERVER_TARGET with default http://localhost:3000. Create playwright.config.ts with viewport 1366×768 and:

~~~ts
webServer: {
  command: 'npx concurrently -k -s first \"HOST=127.0.0.1 PORT=3411 BASE_PATH=/poker npx tsx src/server/index.ts\" \"VITE_BASE_PATH=/poker VITE_SERVER_TARGET=http://127.0.0.1:3411 npx vite --host 127.0.0.1 --port 3410 --strictPort\"',
  url: 'http://127.0.0.1:3410/poker/',
  reuseExistingServer: false,
}
~~~

Never kill a conflicting listener.

- [ ] **Step 5: Write the failing browser geometry test**

Create a room, open Settings, add one AI, close, start, then assert:

~~~ts
const noDocumentScroll = () =>
  document.documentElement.scrollHeight <= window.innerHeight;
expect(await page.evaluate(noDocumentScroll)).toBe(true);
const dock = page.getByRole('region', { name: '我的手牌和操作' });
await expect(dock.getByRole('img')).toHaveCount(2);
const box = await dock.boundingBox();
expect(box).not.toBeNull();
expect(box!.y + box!.height).toBeLessThanOrEqual(768);
~~~

Open Chat and Settings in turn and repeat scroll/dock assertions. Assert the URL remains under /poker/. Playwright captures screenshots only on failure.

- [ ] **Step 6: Observe browser RED, finish responsive CSS, verify GREEN**

Run before completing responsive rules and observe geometry failure, then:

~~~bash
npm run test:e2e
~~~

Expected: PASS; isolated processes and ports close on exit.

- [ ] **Step 7: Verify components and production build**

~~~bash
npx vitest run tests/client-table.test.tsx tests/client-lobby.test.tsx tests/vite-config.test.ts
VITE_BASE_PATH=/poker/ npm run build
~~~

Expected: PASS and /poker/ asset URLs.

- [ ] **Step 8: Commit Task 6**

~~~bash
git add src/client/styles.css vite.config.ts package.json package-lock.json playwright.config.ts tests/layout.e2e.ts tests/client-table.test.tsx tests/client-lobby.test.tsx
git commit -m "feat: redesign the one-screen poker table"
~~~

---

### Task 7: Document and verify the redesign

**Files:**
- Modify: README.md
- Test: all tests/**/*.test.ts(x)
- Test: tests/layout.e2e.ts

**Interfaces:**
- Consumes: Tasks 1–6 and existing /poker/ runtime commands.
- Produces: user instructions for Home, invite copying, side-panel Chat/Settings, confirmed leave, and isolated layout verification.

- [ ] **Step 1: Update README**

Add:

~~~md
- 房间页顶部可复制邀请链接、打开聊天/房主设置，或二次确认后退出房间。
- 桌面牌桌会在一个视口内显示；自己的手牌和操作固定在底部操作台。
- 对局中确认退出会立即弃牌，房主离开后自动转移房主。
~~~

Document npm run test:e2e as isolated ports 3410/3411, never as a shared-8080 operation.

- [ ] **Step 2: Run complete Vitest**

~~~bash
npm test
~~~

Expected: all files/tests pass with zero failures.

- [ ] **Step 3: Run browser acceptance**

~~~bash
npm run test:e2e
~~~

Expected: all Playwright tests pass and ports 3410/3411 close afterward.

- [ ] **Step 4: Run build and repository checks**

~~~bash
VITE_BASE_PATH=/poker/ npm run build
bash -n scripts/shared-8080.sh scripts/shared-8080-ops.sh scripts/shared-8080-cutover.sh scripts/shared-8080-rollback.sh
git diff --check
git status --short
~~~

Expected: build/syntax/diff pass; status lists only README before commit.

- [ ] **Step 5: Run read-only compatibility checks**

~~~bash
curl --noproxy '*' --max-time 5 -fsS http://127.0.0.1:8080/ready
curl --noproxy '*' --max-time 5 -fsS http://127.0.0.1:8080/poker/health
~~~

Expected: Drawing is semantically ready and Poker returns {"ok":true}. Do not restart live services to load this branch; deployment is separately approved after review.

- [ ] **Step 6: Commit Task 7**

~~~bash
git add README.md
git commit -m "docs: explain the poker room cockpit"
~~~

- [ ] **Step 7: Request whole-branch review**

Review every commit after 3e38c35 against the design. Critical and Important findings must be fixed. Explicitly inspect force-fold chip conservation, membership/timer races, reconnect after local/remote leave, dialog focus, host-only settings, duplicate viewer cards, and actual 1366×768 geometry.
