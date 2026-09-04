# Poker Room UX Redesign Design

## Goal

Redesign the LAN poker client around a clear home screen and a compact table cockpit. A desktop player using a
1366×768 viewport must be able to see the entire playing interface without document-level vertical scrolling,
their own hole cards must remain unobstructed, host controls must live in a side panel, and every player must be
able to leave a room through an explicit confirmation flow.

## Product constraints

- The application remains virtual-chip entertainment only. No payment, top-up, withdrawal, or value exchange is
  introduced.
- Existing private room codes, invite links, AI players, chat, reconnect behavior, betting rules, and the
  `/poker/` deployment base path remain compatible.
- The current Drawing API and shared 8080 gateway are outside this change. Development and verification must not
  stop, restart, signal, or reconfigure live services.
- Desktop acceptance targets a 1366×768 CSS viewport. At that size the room page has no document-level vertical
  scroll bar. Individual drawers or message lists may scroll internally.
- Mobile layouts may use internal scrolling and full-screen drawers, but the player's hole cards and primary
  action entry point remain immediately reachable.

## Information architecture

### Home screen

The no-session state is a real home screen rather than a bare form. It contains:

- a concise product title and virtual-chip disclosure;
- one nickname field shared by both actions;
- a primary “创建私人房间” action;
- a visually separate room-code input and “加入房间” action;
- a room code prefilled from a valid invite query parameter;
- connection, validation, and restore feedback in the same card without layout jumps.

Leaving a room clears the saved browser session, removes the `room` query parameter with `history.replaceState`,
and returns to this home screen without a page reload.

### Room cockpit

The desktop room page is a `100dvh` application shell divided into three stable bands:

1. A compact top bar contains the product identity, room code, copy-invite action, connection state, chat
   control, host-settings control when applicable, and a visually distinct leave action.
2. A flexible center stage contains only the poker table and transient notices. The table derives its dimensions
   from the available center-stage width and height, preserves an elliptical aspect ratio, and scales cards,
   seats, spacing, and typography with bounded responsive values.
3. A player dock is anchored below the table inside the viewport. It owns the viewer's two hole cards, stack and
   turn context, countdown, start-game action when applicable, and legal betting actions. The dock has a higher
   stacking layer than the table and drawers, so the viewer's cards cannot be covered.

The document body does not scroll at the desktop acceptance viewport. The shell uses `min-height: 0` on nested
grid/flex regions so the center stage shrinks instead of forcing overflow. Compact-height media queries reduce
seat and card sizes while preserving readable labels and minimum touch targets for actions.

## Side panel

The right side panel is closed by default and is opened from the top bar. It uses tabs rather than displaying
multiple long sections simultaneously:

- Every player has a “聊天” tab. Its message list scrolls internally and the composer remains pinned at the
  bottom of the panel.
- Only the host has a “房主设置” tab. It contains blinds, starting stack, AI style/add/remove controls, busted
  stack resets, and the existing playing-state lock explanation.
- Selecting a top-bar chat or settings control opens the panel directly to that tab. Closing the panel returns
  the reclaimed width to the table.
- On desktop the panel occupies a bounded right column and never increases page height. On narrow screens it is
  a full-screen modal drawer with an accessible close control and focusable tab interface.

The existing settings validation and server commands remain unchanged except for presentation and component
composition.

## Poker table and player dock

- Seat zero through seat eight remain deterministically positioned around the table, but seat cards become
  compact status chips rather than tall information boxes.
- The actor, dealer, small blind, big blind, disconnected, folded, and all-in states remain visible through short
  badges, borders, and restrained color use.
- Community cards and total pot remain centered. Side-pot details are visually secondary and may wrap within the
  center region.
- Other players' hole-card backs or revealed showdown cards stay attached to their seats.
- The viewer's hole cards are rendered exactly once in the player dock, never inside a table seat. They remain
  visible during every phase in which the server exposes them.
- Betting controls no longer use a sticky drawer that can overlap the viewer hand. They share the fixed player
  dock, use compact horizontal grouping on desktop, and collapse into touch-friendly rows on narrow screens.
- Chat and settings never overlay the player dock on desktop. Mobile drawers may cover the table but must leave a
  clear close control and restore the player dock when dismissed.

## Leave-room behavior

### Client flow

The top-bar “退出房间” button opens an accessible confirmation dialog; it never leaves on the first click.

- During an active hand the dialog states: “退出将立即弃牌并离开房间。”
- Outside an active hand it states: “确定退出当前房间吗？”
- “取消” is the initially focused, non-destructive action.
- Confirm is disabled while the request is pending, and duplicate confirmations send one command.
- A successful acknowledgement clears client-bound recovery state, saved local storage, current table/session
  state, open drawers, and the invite query parameter before showing the home screen.
- If transport is already disconnected, confirming performs a local leave immediately. The existing server-side
  disconnect expiry remains responsible for eventual removal; reconnect must not be attempted from that tab.
- A rejected connected leave keeps the user in the room, closes no session state, and presents the server error.

### Protocol and server flow

Add an acknowledged `room:leave` client command with an empty input and empty success result. It is valid only for
the session bound to the issuing socket.

The socket coordinator applies any game-engine transition first, then the room manager owns permanent membership
removal so explicit leave and disconnect expiry share the same invariant-preserving cleanup path:

1. If the player is in an active hand and has not folded, apply a fold before removal. If the player is the actor,
   advance the hand normally; if that fold ends the hand, run the normal settlement path.
2. Remove the player from the seated or waiting collection and invalidate the session token immediately.
3. Cancel that session's disconnect-expiry timer and clear the socket's room/session binding.
4. Transfer host status to the earliest-joined remaining connected human, matching disconnect expiry. Bots never
   become host.
5. Promote an eligible waiter when a seat opens between hands.
6. Broadcast the resulting snapshot and system message to remaining clients.
7. Destroy the room when no human players remain; AI-only rooms are not retained.

An explicit leave must be idempotent at the client interaction boundary. A stale or repeated server command
returns the standard invalid-session error and cannot mutate another player.

## Components and ownership

- `App` continues to own browser session restoration and switches between home and room states. It adds the
  successful/local leave reset boundary and query cleanup.
- A new room header component owns room identity, invite copying, drawer selection, connection summary, and leave
  dialog state.
- `PokerRoom` becomes the cockpit compositor: notices, table stage, side panel, and player dock.
- `RoomControls` remains the host-settings form but renders as side-panel content rather than a page section.
- `PokerTable` renders only table, board, pots, opponents, and seat state.
- A player-dock component renders the viewer hand plus `ActionBar`/start state, keeping this critical layer
  independently testable.
- The socket client exposes a leave operation that clears its recovery binding only after server success, or
  explicitly for the offline-local path.
- The server room manager owns membership removal, session invalidation, host transfer, waiter promotion, and room
  destruction. The socket layer validates the command, applies a forced fold through the existing game transition
  before removal, cancels timers, clears the socket binding, leaves the Socket.IO room, and broadcasts.

## Error handling and accessibility

- Confirmation uses `role="alertdialog"`, an accessible name and description, keyboard dismissal, focus on
  cancel, and focus restoration to the leave button when canceled.
- Side-panel tabs use tab/list/tabpanel semantics and expose expanded state from their top-bar triggers.
- Copy-invite reports success or failure through a small live region without replacing the button label layout.
- Connection and command errors remain live announcements. No server error silently returns the user home.
- Reduced-motion preferences disable nonessential drawer and focus transitions.
- Colors retain sufficient contrast; actor/connection/fold state is never conveyed by color alone.

## Testing and acceptance

### Server and protocol

- Protocol typing accepts `room:leave` and rejects unrelated payloads.
- Waiting, between-hands, non-actor active-hand, and current-actor leaves remove only the caller.
- Active-hand leave records a fold and advances or settles through normal game rules.
- Host leave transfers ownership only to a connected human; the last human leaving destroys an AI-only room.
- Disconnect timers are canceled and stale repeated leave/session commands are harmless.

### Client behavior

- The first leave click opens the correct dialog and sends no command.
- Cancel returns focus and preserves session/storage/query state.
- Confirm sends one command; success clears state and returns to home, while failure preserves the room.
- Offline confirm performs local leave and disables later reconnect for that binding.
- Invite copying, chat/settings tab selection, host-only settings, and drawer close behavior are covered.
- The viewer's exposed hole cards occur once in the player dock and legal actions remain reachable.

### Layout

- Component/CSS contract tests assert the desktop shell, bounded side panel, center-stage shrink rules, player-dock
  layer, and absence of the old sticky action drawer.
- At 1366×768, a browser-level acceptance check confirms `document.documentElement.scrollHeight <= innerHeight`,
  the full player dock and viewer cards are within the viewport, and opening each desktop side-panel tab does not
  introduce document-level vertical overflow.
- Narrow-screen tests confirm the modal drawer semantics and that closing it restores access to the player dock.
- The complete existing game, room, chat, gateway, supervisor, and base-path suites remain green, followed by a
  production build using `VITE_BASE_PATH=/poker/`.

## Non-goals

- No authentication, public room directory, persistence across server restarts, chip economy, spectator mode,
  tournament mode, sound system, or payment feature.
- No rewrite of poker rules, AI strategy, Drawing API, shared gateway, or deployment topology.
- No requirement to fit every mobile screen without any scrolling; mobile prioritizes immediate cards/actions and
  bounded internal drawer scrolling.
