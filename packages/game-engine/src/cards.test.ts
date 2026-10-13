import { cardSchema } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { createStandardDeck, STANDARD_RANKS, SUITS } from './cards.js';

describe('createStandardDeck', () => {
  it('creates exactly 54 unique cards accepted by the shared schema', () => {
    const deck = createStandardDeck();
    expect(deck).toHaveLength(54);
    expect(new Set(deck.map((card) => card.id))).toHaveLength(54);
    for (const card of deck)
      expect(cardSchema.safeParse(card).success).toBe(true);
  });

  it('contains all 13 ranks in each of the four suits', () => {
    const deck = createStandardDeck();
    for (const suit of SUITS) {
      expect(
        deck.filter((card) => card.kind === 'standard' && card.suit === suit),
      ).toHaveLength(13);
    }
    expect(STANDARD_RANKS).toHaveLength(13);
  });

  it('contains exactly one small joker and one big joker', () => {
    const jokers = createStandardDeck().filter((card) => card.kind === 'joker');
    expect(jokers.map((card) => card.rank)).toEqual([
      'small-joker',
      'big-joker',
    ]);
  });

  it('returns a fresh independently mutable deck on every call', () => {
    const first = createStandardDeck();
    const second = createStandardDeck();
    first.pop();
    expect(second).toHaveLength(54);
  });
});
