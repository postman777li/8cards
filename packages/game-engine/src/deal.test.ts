import type { Card } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { createStandardDeck } from './cards.js';
import { dealInitialHands, selectIndicator } from './deal.js';

function cardIds(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

function assertConservation(result: ReturnType<typeof dealInitialHands>): void {
  const allCards = [...result.hands.values()]
    .flatMap(cardIds)
    .concat(cardIds(result.stock));
  expect(allCards).toHaveLength(54);
  expect(new Set(allCards)).toEqual(new Set(cardIds(createStandardDeck())));
}

describe('selectIndicator', () => {
  it('selects a predictable card inside the guaranteed initial-draw range', () => {
    const selection = selectIndicator(createStandardDeck(), 2, () => 0.5);
    expect(selection.index).toBe(8);
    expect(selection.card.id).toBe('clubs-10');
    expect(selection.index).toBeLessThan(16);
  });

  it('discards a joker candidate and reselects a non-joker', () => {
    const deck = createStandardDeck();
    [deck[0], deck[52]] = [deck[52]!, deck[0]!];
    const values = [0, 0];
    const selection = selectIndicator(deck, 2, () => values.shift() ?? 0);
    expect(selection.card.kind).toBe('standard');
    expect(selection.index).toBe(1);
  });

  it('terminates with a degenerate random source even when both jokers are selected first', () => {
    const deck = createStandardDeck();
    [deck[0], deck[52]] = [deck[52]!, deck[0]!];
    [deck[1], deck[53]] = [deck[53]!, deck[1]!];
    const selection = selectIndicator(deck, 2, () => 0);
    expect(selection.index).toBe(2);
    expect(selection.card.kind).toBe('standard');
  });

  it('rejects an initial-draw range containing no ordinary card', () => {
    const jokersOnly = Array.from({ length: 16 }, (_, index): Card => ({
      id: index % 2 === 0 ? 'small-joker' : 'big-joker',
      kind: 'joker',
      rank: index % 2 === 0 ? 'small-joker' : 'big-joker',
    }));
    expect(() => selectIndicator(jokersOnly, 2, () => 0)).toThrow(/non-joker/);
  });
});

describe.each([2, 3, 4])('%i-player initial draw', (playerCount) => {
  it('deals eight cards in input order, replaces the indicator immediately, and preserves all cards', () => {
    const players = Array.from(
      { length: playerCount },
      (_, index) => `player-${index + 1}`,
    );
    const deck = createStandardDeck();
    const indicatorIndex = playerCount + 1;
    const result = dealInitialHands(
      deck,
      players,
      () => indicatorIndex / (playerCount * 8),
    );
    const expectedDefender = players[indicatorIndex % playerCount];

    for (const player of players)
      expect(result.hands.get(player)).toHaveLength(8);
    expect(result.firstDefender).toBe(expectedDefender);
    expect(result.indicatorOriginalIndex).toBe(indicatorIndex);
    expect(result.trumpSuit).toBe(result.indicator.suit);
    expect(result.stock.at(-1)).toEqual(result.indicator);
    expect(
      [...result.hands.values()]
        .flat()
        .some((card) => card.id === result.indicator.id),
    ).toBe(false);
    expect(result.stock).toHaveLength(54 - playerCount * 8);
    expect(result.drawOrder.slice(0, playerCount * 2)).toEqual([
      ...players,
      ...players,
    ]);
    expect(result.hands.get(expectedDefender!)?.[1]?.id).toBe(
      deck[indicatorIndex + 1]?.id,
    );
    assertConservation(result);
  });
});

describe('initial draw validation', () => {
  it('rejects unsupported player counts', () => {
    expect(() =>
      dealInitialHands(createStandardDeck(), ['alone'], () => 0),
    ).toThrow(/2, 3, or 4/);
  });

  it('rejects duplicate player identifiers', () => {
    expect(() =>
      dealInitialHands(createStandardDeck(), ['same', 'same'], () => 0),
    ).toThrow(/unique/);
  });

  it('rejects incomplete or duplicate decks', () => {
    const incomplete = createStandardDeck().slice(1);
    expect(() => dealInitialHands(incomplete, ['a', 'b'], () => 0)).toThrow(
      /54/,
    );
    const duplicate = createStandardDeck();
    duplicate[1] = duplicate[0]!;
    expect(() => dealInitialHands(duplicate, ['a', 'b'], () => 0)).toThrow(
      /exactly once/,
    );
  });
});
