import type { Card, StandardRank, Suit } from '@8cards/shared';

export type CardComparison = -1 | 0 | 1 | null;

const RANK_VALUE: Readonly<Record<StandardRank, number>> = {
  '2': 0,
  '3': 1,
  '4': 2,
  '5': 3,
  '6': 4,
  '7': 5,
  '8': 6,
  '9': 7,
  '10': 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
};

export function standardRankValue(rank: StandardRank): number {
  return RANK_VALUE[rank];
}

export function compareCards(
  left: Card,
  right: Card,
  trumpSuit: Suit,
): CardComparison {
  if (left.kind === 'joker' && right.kind === 'joker') return 0;
  if (left.kind === 'joker') return 1;
  if (right.kind === 'joker') return -1;

  const leftIsTrump = left.suit === trumpSuit;
  const rightIsTrump = right.suit === trumpSuit;
  if (leftIsTrump !== rightIsTrump) return leftIsTrump ? 1 : -1;
  if (!leftIsTrump && left.suit !== right.suit) return null;

  return Math.sign(
    standardRankValue(left.rank) - standardRankValue(right.rank),
  ) as -1 | 0 | 1;
}
