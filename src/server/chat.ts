import type { ChatMessage, ChatMessageSender } from '../shared/protocol';

const MAX_MESSAGE_LENGTH = 300;
const MAX_MESSAGES_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_MS = 5_000;
const MAX_ROOM_HISTORY = 100;

export type ChatErrorCode = 'INVALID_MESSAGE' | 'RATE_LIMITED';

export class ChatRuleError extends Error {
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = 'ChatRuleError';
    this.code = code;
  }
}

export interface ChatSender extends ChatMessageSender {
  sessionId: string;
}

export type RoomSystemEvent =
  | { type: 'player-joined'; nickname: string }
  | { type: 'player-left'; nickname: string }
  | { type: 'host-transferred'; nickname: string }
  | { type: 'hand-started' }
  | { type: 'timeout-action'; nickname: string; action: 'check' | 'fold' }
  | { type: 'bot-added'; nickname: string }
  | { type: 'bot-removed'; nickname: string }
  | { type: 'hand-settled'; payouts: ReadonlyArray<{ nickname: string; amount: number }> };

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.sender === undefined ? {} : { sender: { ...message.sender } }),
  };
}

export function systemMessageText(event: RoomSystemEvent): string {
  switch (event.type) {
    case 'player-joined':
      return `${event.nickname} 加入了房间`;
    case 'player-left':
      return `${event.nickname} 离开了房间`;
    case 'host-transferred':
      return `${event.nickname} 成为新房主`;
    case 'hand-started':
      return '新一手牌开始了';
    case 'timeout-action':
      return `${event.nickname} 超时，自动${event.action === 'check' ? '过牌' : '弃牌'}`;
    case 'bot-added':
      return `已添加机器人 ${event.nickname}`;
    case 'bot-removed':
      return `已移除机器人 ${event.nickname}`;
    case 'hand-settled': {
      if (event.payouts.length === 0) return '本手牌已结算';
      const payouts = event.payouts
        .map(({ nickname, amount }) => `${nickname} +${amount}`)
        .join('，');
      return `本手牌结算：${payouts}`;
    }
  }
}

export class ChatService {
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly sessionTimestamps = new Map<string, Map<string, number[]>>();
  private nextMessageId = 1;

  send(roomId: string, sender: ChatSender, text: string, now: number): ChatMessage {
    const normalizedText = text.trim();
    const length = Array.from(normalizedText).length;
    if (length < 1 || length > MAX_MESSAGE_LENGTH) {
      throw new ChatRuleError('INVALID_MESSAGE', 'Message must contain 1 to 300 characters');
    }

    const roomTimestamps = this.sessionTimestamps.get(roomId) ?? new Map<string, number[]>();
    const recent = (roomTimestamps.get(sender.sessionId) ?? [])
      .filter((sentAt) => sentAt > now - RATE_LIMIT_WINDOW_MS);
    if (recent.length >= MAX_MESSAGES_PER_WINDOW) {
      roomTimestamps.set(sender.sessionId, recent);
      this.sessionTimestamps.set(roomId, roomTimestamps);
      throw new ChatRuleError('RATE_LIMITED', 'Messages are being sent too quickly');
    }
    recent.push(now);
    roomTimestamps.set(sender.sessionId, recent);
    this.sessionTimestamps.set(roomId, roomTimestamps);

    return this.append(roomId, {
      id: this.nextMessageId++,
      kind: 'player',
      text: normalizedText,
      sentAt: now,
      sender: {
        playerId: sender.playerId,
        nickname: sender.nickname,
        seatIndex: sender.seatIndex,
      },
    });
  }

  system(roomId: string, text: string, now: number): ChatMessage {
    return this.append(roomId, {
      id: this.nextMessageId++,
      kind: 'system',
      text,
      sentAt: now,
    });
  }

  history(roomId: string): ChatMessage[] {
    return (this.histories.get(roomId) ?? []).map(cloneMessage);
  }

  clear(roomId: string): void {
    this.histories.delete(roomId);
    this.sessionTimestamps.delete(roomId);
  }

  private append(roomId: string, message: ChatMessage): ChatMessage {
    const messages = [...(this.histories.get(roomId) ?? []), cloneMessage(message)]
      .slice(-MAX_ROOM_HISTORY);
    this.histories.set(roomId, messages);
    return cloneMessage(message);
  }
}
