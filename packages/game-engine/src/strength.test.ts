import type { Card, StandardRank, Suit } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { STANDARD_RANKS } from './cards.js';
import { compareCards, standardRankValue } from './strength.js';

const standard = (rank: StandardRank, suit: Suit = 'clubs'): Card => ({
  id: `${suit}-${rank}`,
  kind: 'standard',
  suit,
  rank,
});
const smallJoker: Card = {
  id: 'small-joker',
  kind: 'joker',
  rank: 'small-joker',
};
const bigJoker: Card = { id: 'big-joker', kind: 'joker', rank: 'big-joker' };

describe('card strength', () => {
  it('orders every ordinary rank from 2 through ace', () => {
    expect(STANDARD_RANKS.map(standardRankValue)).toEqual(
      STANDARD_RANKS.map((_, index) => index),
    );
    for (let index = 1; index < STANDARD_RANKS.length; index += 1) {
      expect(
        compareCards(
          standard(STANDARD_RANKS[index]!),
          standard(STANDARD_RANKS[index - 1]!),
          'hearts',
        ),
      ).toBe(1);
    }
  });

  it('treats both jokers as equal and stronger than every ordinary card', () => {
    expect(compareCards(smallJoker, bigJoker, 'clubs')).toBe(0);
    expect(compareCards(bigJoker, standard('A', 'clubs'), 'clubs')).toBe(1);
    expect(compareCards(standard('A', 'clubs'), smallJoker, 'clubs')).toBe(-1);
  });

  it('ranks any trump above any non-trump ordinary card', () => {
    expect(
      compareCards(standard('2', 'hearts'), standard('A', 'spades'), 'hearts'),
    ).toBe(1);
  });

  it('compares ordinary cards of the same suit by rank', () => {
    expect(
      compareCards(
        standard('K', 'diamonds'),
        standard('3', 'diamonds'),
        'clubs',
      ),
    ).toBe(1);
    expect(
      compareCards(
        standard('7', 'diamonds'),
        standard('7', 'diamonds'),
        'clubs',
      ),
    ).toBe(0);
  });

  it('returns null for ordinary non-trumps of different suits', () => {
    expect(
      compareCards(standard('A', 'clubs'), standard('2', 'diamonds'), 'hearts'),
    ).toBeNull();
  });
});
