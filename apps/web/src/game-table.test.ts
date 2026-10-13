import type { Card, GamePublicState } from '@8cards/shared';
import { describe, expect, it } from 'vitest';
import { pairTable, secondsRemaining, sortHand } from './game-table.js';

const card = (id: string): Card => {
  if (id === 'small-joker' || id === 'big-joker')
    return { id, kind: 'joker', rank: id } as Card;
  const [suit, rank] = id.split('-');
  return { id, kind: 'standard', suit, rank } as Card;
};

describe('game table authority mapping', () => {
  it('sorts a display copy without changing card ids or the server hand', () => {
    const hand = [card('big-joker'), card('hearts-A'), card('clubs-3')];
    expect(sortHand(hand).map((item) => item.id)).toEqual([
      'clubs-3',
      'hearts-A',
      'big-joker',
    ]);
    expect(hand.map((item) => item.id)).toEqual([
      'big-joker',
      'hearts-A',
      'clubs-3',
    ]);
  });

  it('pairs public attack and defense purposes and retains an uncovered attack', () => {
    const table = [
      { playerId: 'p1', card: card('clubs-3'), purpose: 'attack' },
      { playerId: 'p2', card: card('clubs-4'), purpose: 'defense' },
      { playerId: 'p1', card: card('hearts-4'), purpose: 'attack' },
    ] as GamePublicState['table'];
    const pairs = pairTable(table);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.defense?.card.id).toBe('clubs-4');
    expect(pairs[1]?.attack.card.id).toBe('hearts-4');
    expect(pairs[1]?.defense).toBeUndefined();
  });

  it('uses the authoritative deadline and never goes below zero', () => {
    const deadline = '2026-10-13T12:00:20.000Z';
    expect(
      secondsRemaining(deadline, Date.parse('2026-10-13T12:00:14.100Z')),
    ).toBe(6);
    expect(
      secondsRemaining(deadline, Date.parse('2026-10-13T12:00:21.000Z')),
    ).toBe(0);
    expect(secondsRemaining(null, Date.now())).toBeNull();
  });
});
