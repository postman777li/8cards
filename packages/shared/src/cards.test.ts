import { describe, expect, it } from 'vitest';

import { cardSchema } from './cards.js';

const suits = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
const ranks = [
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
] as const;

describe('card identity validation', () => {
  it('accepts all 52 matching standard card identities', () => {
    for (const suit of suits) {
      for (const rank of ranks) {
        expect(
          cardSchema.safeParse({
            id: `${suit}-${rank}`,
            kind: 'standard',
            suit,
            rank,
          }).success,
        ).toBe(true);
      }
    }
  });

  it.each(['small-joker', 'big-joker'] as const)(
    'accepts the matching %s identity',
    (rank) => {
      expect(
        cardSchema.safeParse({ id: rank, kind: 'joker', rank }).success,
      ).toBe(true);
    },
  );

  it.each([
    { id: 'hearts-A', kind: 'standard', suit: 'spades', rank: '2' },
    { id: 'clubs-10', kind: 'standard', suit: 'clubs', rank: 'J' },
    { id: 'diamonds-K', kind: 'standard', suit: 'hearts', rank: 'K' },
  ])(
    'rejects a standard card whose ID disagrees with its face fields',
    (card) => {
      expect(cardSchema.safeParse(card).success).toBe(false);
    },
  );

  it.each([
    { id: 'small-joker', kind: 'joker', rank: 'big-joker' },
    { id: 'big-joker', kind: 'joker', rank: 'small-joker' },
  ])('rejects a joker whose ID disagrees with its rank', (card) => {
    expect(cardSchema.safeParse(card).success).toBe(false);
  });
});
