import type { Card } from '../game/types';

const SUITS = {
  c: { name: '梅花', glyph: '♣', tone: 'black' },
  d: { name: '方块', glyph: '♦', tone: 'red' },
  h: { name: '红桃', glyph: '♥', tone: 'red' },
  s: { name: '黑桃', glyph: '♠', tone: 'black' },
} as const;

const RANKS: Record<Card['rank'], string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
}

export function PlayingCard({ card, faceDown = false }: PlayingCardProps): React.JSX.Element {
  if (faceDown || card === undefined) {
    return <span className="playing-card card-back" role="img" aria-label="底牌" />;
  }

  const suit = SUITS[card.suit];
  const rank = RANKS[card.rank];
  return (
    <span className={`playing-card card-${suit.tone}`} role="img" aria-label={`${suit.name} ${rank}`}>
      <span aria-hidden="true" className="card-rank">{rank}</span>
      <span aria-hidden="true" className="card-suit">{suit.glyph}</span>
    </span>
  );
}
