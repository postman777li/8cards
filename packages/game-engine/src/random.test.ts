import { describe, expect, it } from 'vitest';

import { createStandardDeck } from './cards.js';
import { randomIndex, shuffleCards } from './random.js';

function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe('shuffleCards', () => {
  it('produces the same known permutation from the same random sequence', () => {
    const values = [0, 0.5, 0.25];
    expect(shuffleCards(['a', 'b', 'c', 'd'], sequenceRandom(values))).toEqual([
      'c',
      'd',
      'b',
      'a',
    ]);
    expect(shuffleCards(['a', 'b', 'c', 'd'], sequenceRandom(values))).toEqual([
      'c',
      'd',
      'b',
      'a',
    ]);
  });

  it('preserves all 54 cards without duplicates or omissions', () => {
    const deck = createStandardDeck();
    const shuffled = shuffleCards(deck, () => 0.375);
    expect(new Set(shuffled.map((card) => card.id))).toEqual(
      new Set(deck.map((card) => card.id)),
    );
  });

  it('does not mutate its input', () => {
    const input = ['a', 'b', 'c'];
    shuffleCards(input, () => 0);
    expect(input).toEqual(['a', 'b', 'c']);
  });

  it.each([0, 0.999_999])('accepts the random boundary value %s', (value) => {
    expect(randomIndex(4, () => value)).toBe(value === 0 ? 0 : 3);
  });

  it.each([-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid random value %s',
    (value) => {
      expect(() => randomIndex(4, () => value)).toThrow(/\[0, 1\)/);
    },
  );
});
