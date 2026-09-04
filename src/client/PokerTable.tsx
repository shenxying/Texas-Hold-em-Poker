import type { PublicPlayer, TableView } from '../shared/protocol';
import { PlayingCard } from './PlayingCard';

const ACTION_LABELS: Record<string, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  'all-in': '全下',
};

interface PokerTableProps {
  view: TableView;
  playerId: string;
}

function nextOccupiedSeat(seats: readonly number[], from: number): number | undefined {
  return seats.find((seat) => seat > from) ?? seats[0];
}

function blindSeats(view: TableView): { small?: number; big?: number } {
  const dealtPlayers = view.players.filter((player) => player.holeCardCount > 0);
  if (view.dealerSeatIndex === undefined || dealtPlayers.length < 2) return {};
  const seats = dealtPlayers.map((player) => player.seatIndex).sort((a, b) => a - b);
  const small = seats.length === 2
    ? view.dealerSeatIndex
    : nextOccupiedSeat(seats, view.dealerSeatIndex);
  const big = small === undefined ? undefined : nextOccupiedSeat(seats, small);
  return { small, big };
}

function SeatCards({ player }: { player: PublicPlayer }): React.JSX.Element | null {
  if (player.holeCards !== undefined) {
    return (
      <div className="hole-cards revealed-cards" aria-label={`${player.nickname} 的公开手牌`}>
        {player.holeCards.map((card, index) => <PlayingCard key={index} card={card} />)}
      </div>
    );
  }
  if (player.holeCardCount === 0) return null;
  return (
    <div className="hole-cards hidden-cards" aria-label={`${player.nickname} 的底牌`}>
      {Array.from({ length: player.holeCardCount }, (_, index) => (
        <PlayingCard key={index} faceDown />
      ))}
    </div>
  );
}

export function PokerTable({ view, playerId }: PokerTableProps): React.JSX.Element {
  const playersBySeat = new Map(view.players.map((player) => [player.seatIndex, player]));
  const blinds = blindSeats(view);
  const totalPot = view.pots.reduce((total, pot) => total + pot.amount, 0);

  function markersFor(seatIndex: number): string[] {
    return [
      ...(view.dealerSeatIndex === seatIndex ? ['庄家'] : []),
      ...(blinds.small === seatIndex ? ['小盲'] : []),
      ...(blinds.big === seatIndex ? ['大盲'] : []),
    ];
  }

  return (
    <section className="poker-table-wrap" aria-label="德州牌桌">
      <div className="seat-summary" aria-label="座位摘要">
        {view.players.map((player) => (
          <article className="seat-summary-item" data-testid={`seat-summary-${player.seatIndex}`} key={player.id}>
            <strong>{player.seatIndex + 1}号 {player.nickname}{player.isBot ? ' · AI' : ''}</strong>
            <span>{player.connected ? '已连接' : '已断线'}</span>
            <span>筹码 {player.stack}</span>
            <span>本街 {player.streetBet}</span>
            {player.lastAction !== undefined && <span>{ACTION_LABELS[player.lastAction] ?? player.lastAction}</span>}
            {markersFor(player.seatIndex).map((marker) => <span key={marker}>{marker}</span>)}
            {player.folded && <span>已弃牌</span>}
            {player.allIn && <span>已全下</span>}
          </article>
        ))}
      </div>
      <div className="poker-table">
        <div className="table-center">
          <p className="pot-total">总底池 {totalPot}</p>
          <div className="pot-breakdown">
            {view.pots.map((pot, index) => (
              <span key={index}>{index === 0 ? '主池' : index === 1 ? '边池' : `边池 ${index}`} {pot.amount}</span>
            ))}
          </div>
          <div className="board" aria-label="公共牌">
            {view.board.map((card, index) => <PlayingCard key={index} card={card} />)}
            {Array.from({ length: 5 - view.board.length }, (_, index) => (
              <span key={`placeholder-${index}`} className="card-placeholder" aria-hidden="true" />
            ))}
          </div>
        </div>
        {Array.from({ length: 9 }, (_, seatIndex) => {
          const current = playersBySeat.get(seatIndex);
          return (
            <article
              className={`table-seat seat-${seatIndex}${current !== undefined && current.id === view.actorId ? ' current-actor' : ''}${current?.folded ? ' folded' : ''}`}
              data-testid={`seat-${seatIndex}`}
              key={seatIndex}
              aria-label={`${seatIndex + 1}号座位${current === undefined ? '，空座' : `，${current.nickname}`}`}
            >
              {current === undefined ? <span className="empty-seat">空座</span> : (
                <>
                  <div className="seat-markers" aria-label="位置标记">
                    {markersFor(seatIndex).map((marker) => <span key={marker}>{marker}</span>)}
                  </div>
                  <strong>{current.nickname}{current.isBot ? ' · AI' : ''}</strong>
                  <span>{current.connected ? '已连接' : '已断线'}</span>
                  <span>筹码 {current.stack}</span>
                  <span>本街 {current.streetBet}</span>
                  {current.lastAction !== undefined && <span>{ACTION_LABELS[current.lastAction] ?? current.lastAction}</span>}
                  {current.allIn && <span>已全下</span>}
                  {current.id !== playerId && <SeatCards player={current} />}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
