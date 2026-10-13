import type { Card, StandardCard, StandardRank, Suit } from '@8cards/shared';

export const SUITS = [
  'clubs',
  'diamonds',
  'hearts',
  'spades',
] as const satisfies readonly Suit[];

export const STANDARD_RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const satisfies readonly StandardRank[];

export function createStandardDeck(): Card[] {
  const standardCards: StandardCard[] = SUITS.flatMap((suit) =>
    STANDARD_RANKS.map((rank) => ({
      id: `${suit}-${rank}`,
      kind: 'standard' as const,
      suit,
      rank,
    })),
  );

  return [
    ...standardCards,
    { id: 'small-joker', kind: 'joker', rank: 'small-joker' },
    { id: 'big-joker', kind: 'joker', rank: 'big-joker' },
  ];
}
