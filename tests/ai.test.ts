import { describe, expect, it } from 'vitest';
import { botDelayMs, chooseBotAction } from '../src/server/ai';
import type { BotStyle } from '../src/shared/protocol';
import { botScenario } from './support/bots';

const STYLES: readonly BotStyle[] = ['tight', 'balanced', 'aggressive'];

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
    expect(botDelayMs(() => 1)).toBe(1800);
  });

  it('prefers a free check over folding a weak hand', () => {
    const action = chooseBotAction(
      botScenario({ holeCards: '7c 2d', legal: ['fold', 'check'] }),
      () => 0.5,
    );

    expect(action.type).toBe('check');
  });

  it('has a tight bot fold a weak offsuit hand facing a large bet', () => {
    const action = chooseBotAction(
      botScenario({
        style: 'tight',
        holeCards: '7c 2d',
        legal: ['fold', 'call', 'raise', 'all-in'],
        pot: 30,
        callAmount: 100,
        minRaiseTo: 200,
        maxRaiseTo: 500,
      }),
      () => 0.5,
    );

    expect(action.type).toBe('fold');
  });

  it.each(STYLES)('%s value-raises pocket aces when raising is legal', (style) => {
    const action = chooseBotAction(
      botScenario({
        style,
        holeCards: 'Ac Ad',
        legal: ['fold', 'call', 'raise', 'all-in'],
        pot: 120,
        callAmount: 20,
        minRaiseTo: 60,
        maxRaiseTo: 600,
        effectiveStack: 600,
      }),
      () => 0.5,
    );

    expect(action.type).toBe('raise');
  });

  it('lets aggressive raise a strong draw where tight calls', () => {
    const scenario = {
      holeCards: 'Ah Kh',
      board: 'Qh Jh 2c',
      legal: ['fold', 'call', 'raise', 'all-in'] as const,
      pot: 100,
      callAmount: 20,
      minRaiseTo: 50,
      maxRaiseTo: 500,
      effectiveStack: 500,
    };

    expect(chooseBotAction(botScenario({ ...scenario, style: 'tight' }), () => 0.5).type)
      .toBe('call');
    expect(chooseBotAction(botScenario({ ...scenario, style: 'aggressive' }), () => 0.5).type)
      .toBe('raise');
  });

  it.each(STYLES)('%s never raises when canRaise is false', (style) => {
    const action = chooseBotAction(
      botScenario({
        style,
        holeCards: 'Ac Ad',
        legal: ['fold', 'call', 'all-in'],
        callAmount: 20,
      }),
      () => 0.5,
    );

    expect(action.type).not.toBe('raise');
  });

  it('returns an integer raise-to total clamped to the supplied bounds', () => {
    const action = chooseBotAction(
      botScenario({
        style: 'aggressive',
        holeCards: 'Ac Ad',
        legal: ['fold', 'call', 'raise'],
        pot: 101,
        callAmount: 10,
        minRaiseTo: 81,
        maxRaiseTo: 119,
        effectiveStack: 1_000,
      }),
      () => 0.5,
    );

    expect(action.type).toBe('raise');
    if (action.type === 'raise') {
      expect(Number.isInteger(action.amount)).toBe(true);
      expect(action.amount).toBeGreaterThanOrEqual(81);
      expect(action.amount).toBeLessThanOrEqual(119);
    }
  });
});
