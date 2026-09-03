import { useEffect, useState, type FormEvent } from 'react';
import type { BotStyle, RoomSettings, TableView } from '../shared/protocol';
import type { PokerClient } from './socket';

interface RoomControlsProps {
  client: PokerClient;
  view: TableView;
  playerId: string;
  connected: boolean;
  onError: (message: string) => void;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

function validateSettings(settings: RoomSettings): string | undefined {
  if (
    !Number.isInteger(settings.startingStack) ||
    settings.startingStack < 1_000 ||
    settings.startingStack > 1_000_000
  ) {
    return '初始筹码必须是 1,000–1,000,000 的整数';
  }
  if (!Number.isInteger(settings.smallBlind) || settings.smallBlind <= 0) {
    return '小盲必须是正整数';
  }
  if (!Number.isInteger(settings.bigBlind) || settings.bigBlind <= 0) {
    return '大盲必须是正整数';
  }
  if (settings.bigBlind < settings.smallBlind || settings.bigBlind > settings.startingStack) {
    return '大盲必须不小于小盲，且不能超过初始筹码';
  }
  return undefined;
}

export function RoomControls({
  client,
  view,
  playerId,
  connected,
  onError,
}: RoomControlsProps): React.JSX.Element | null {
  const isHost = view.players.some((player) => player.id === playerId && player.isHost);
  const [startingStack, setStartingStack] = useState(String(view.settings.startingStack));
  const [smallBlind, setSmallBlind] = useState(String(view.settings.smallBlind));
  const [bigBlind, setBigBlind] = useState(String(view.settings.bigBlind));
  const [style, setStyle] = useState<BotStyle>('balanced');
  const [help, setHelp] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setStartingStack(String(view.settings.startingStack));
    setSmallBlind(String(view.settings.smallBlind));
    setBigBlind(String(view.settings.bigBlind));
  }, [view.settings.startingStack, view.settings.smallBlind, view.settings.bigBlind]);

  if (!isHost) return null;

  const disabled = view.phase === 'playing' || pending || !connected;

  async function run(operation: () => Promise<unknown>): Promise<void> {
    setPending(true);
    try {
      await operation();
    } catch (error) {
      onError(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  function saveSettings(event: FormEvent): void {
    event.preventDefault();
    const settings = {
      startingStack: Number(startingStack),
      smallBlind: Number(smallBlind),
      bigBlind: Number(bigBlind),
    };
    const validationMessage = validateSettings(settings);
    if (validationMessage !== undefined) {
      setHelp(validationMessage);
      return;
    }
    setHelp('');
    void run(() => client.send('room:update-settings', { settings }));
  }

  const bots = view.players.filter((player) => player.isBot);
  const bustedHumans = view.players.filter((player) => !player.isBot && player.stack === 0);

  return (
    <section className="room-controls" aria-labelledby="room-controls-title">
      <h2 id="room-controls-title">房主设置</h2>
      <form onSubmit={saveSettings} noValidate>
        <label htmlFor="starting-stack">初始筹码</label>
        <input id="starting-stack" type="number" min="1000" max="1000000" step="1"
          value={startingStack} onChange={(event) => setStartingStack(event.target.value)} disabled={disabled} />
        <label htmlFor="small-blind">小盲</label>
        <input id="small-blind" type="number" min="1" step="1"
          value={smallBlind} onChange={(event) => setSmallBlind(event.target.value)} disabled={disabled} />
        <label htmlFor="big-blind">大盲</label>
        <input id="big-blind" type="number" min="1" step="1"
          value={bigBlind} onChange={(event) => setBigBlind(event.target.value)} disabled={disabled} />
        {help !== '' && <p className="field-help">{help}</p>}
        <button type="submit" disabled={disabled}>保存设置</button>
      </form>

      <div className="bot-controls">
        <label htmlFor="bot-style">AI 风格</label>
        <select id="bot-style" value={style}
          onChange={(event) => setStyle(event.target.value as BotStyle)} disabled={disabled}>
          <option value="tight">保守型</option>
          <option value="balanced">均衡型</option>
          <option value="aggressive">激进型</option>
        </select>
        <button type="button" disabled={disabled}
          onClick={() => void run(() => client.send('room:add-bot', { style }))}>添加 AI</button>
        {bots.map((bot) => (
          <button key={bot.id} type="button" disabled={disabled}
            onClick={() => void run(() => client.send('room:remove-bot', { playerId: bot.id }))}>
            移除 {bot.nickname}
          </button>
        ))}
      </div>

      {bustedHumans.map((human) => (
        <button key={human.id} type="button" disabled={disabled}
          onClick={() => void run(() => client.send('room:reset-stack', { playerId: human.id }))}>
          重置 {human.nickname} 筹码
        </button>
      ))}
      {view.phase === 'playing' && <p>手牌进行中，房间设置暂时锁定。</p>}
    </section>
  );
}
