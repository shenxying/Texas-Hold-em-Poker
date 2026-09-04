import { useEffect, useMemo, useState } from 'react';
import type { LegalActions } from '../game/types';
import type { ClientPlayerAction } from '../shared/protocol';

interface ActionBarProps {
  legalActions: LegalActions;
  potTotal: number;
  streetBet: number;
  deadline?: number;
  disabled: boolean;
  onAct: (action: ClientPlayerAction) => Promise<unknown>;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function ActionBar({
  legalActions,
  potTotal,
  streetBet,
  deadline,
  disabled,
  onAct,
}: ActionBarProps): React.JSX.Element {
  const minimum = legalActions.minRaiseTo ?? 0;
  const [amountText, setAmountText] = useState(String(minimum));
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const amount = clamp(Number(amountText), minimum, legalActions.maxRaiseTo);
  const wagerType = legalActions.canRaise ? 'raise' : 'bet';
  const wagerLabel = wagerType === 'raise' ? '加注到' : '下注到';

  useEffect(() => {
    setAmountText(String(minimum));
  }, [minimum, legalActions.maxRaiseTo, wagerType]);

  useEffect(() => {
    if (deadline === undefined) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const shortcuts = useMemo(() => {
    const values = [
      { label: '半池', amount: streetBet + Math.round(potTotal / 2) },
      { label: '3/4 池', amount: streetBet + Math.round(potTotal * 0.75) },
    ];
    return values.filter(({ amount: shortcut }, index) => (
      shortcut >= minimum && shortcut <= legalActions.maxRaiseTo &&
      values.findIndex(({ amount: candidate }) => candidate === shortcut) === index
    ));
  }, [legalActions.maxRaiseTo, minimum, potTotal, streetBet]);

  async function act(action: ClientPlayerAction): Promise<void> {
    if (pending || disabled) return;
    setPending(true);
    try {
      await onAct(action);
    } finally {
      setPending(false);
    }
  }

  const remaining = deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1_000));
  const barDisabled = disabled || pending;
  return (
    <fieldset className="action-bar dock-action-bar" aria-label="玩家操作" disabled={barDisabled}>
      <legend>玩家操作</legend>
      {remaining !== undefined && <p className="action-countdown" aria-live="polite">剩余 {remaining} 秒</p>}
      <div className="action-buttons">
        {legalActions.canFold && <button type="button" onClick={() => void act({ type: 'fold' })}>弃牌</button>}
        {legalActions.canCheck && <button type="button" onClick={() => void act({ type: 'check' })}>过牌</button>}
        {legalActions.canCall && (
          <button type="button" onClick={() => void act({ type: 'call' })}>跟注 {legalActions.callAmount}</button>
        )}
        {(legalActions.canBet || legalActions.canRaise) && (
          <div className="wager-controls">
            <label htmlFor="wager-total">{wagerLabel}</label>
            <input
              id="wager-total"
              type="number"
              min={minimum}
              max={legalActions.maxRaiseTo}
              step="1"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              onBlur={() => setAmountText(String(amount))}
            />
            <input
              className="wager-range"
              type="range"
              aria-label={`${wagerLabel}滑块`}
              min={minimum}
              max={legalActions.maxRaiseTo}
              step="1"
              value={amount}
              onChange={(event) => setAmountText(String(clamp(
                Number(event.target.value), minimum, legalActions.maxRaiseTo,
              )))}
            />
            <div className="wager-shortcuts">
              {shortcuts.map((shortcut) => (
                <button key={shortcut.label} type="button" onClick={() => setAmountText(String(shortcut.amount))}>
                  {shortcut.label} {shortcut.amount}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void act({ type: wagerType, amount })}>
              {wagerLabel} {amount}
            </button>
          </div>
        )}
        {legalActions.canAllIn && <button type="button" onClick={() => void act({ type: 'all-in' })}>全下</button>}
      </div>
    </fieldset>
  );
}
