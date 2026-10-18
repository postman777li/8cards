import { describe, it, expect } from 'vitest';
import { roundResultSchema, presentationSchema } from './game-state.js';

describe('task 23 strict public protocol', () => {
  const result = {
    roundNumber: 1,
    reason: 'stuck-with-jokers',
    participants: [
      {
        playerId: 'A',
        rank: 1,
        baseScore: 1,
        multiplier: 3,
        delta: 3,
        totalScore: 3,
        outcome: 'win',
      },
      {
        playerId: 'B',
        rank: 2,
        baseScore: -1,
        multiplier: 3,
        delta: -3,
        totalScore: -3,
        outcome: 'loss',
      },
    ],
  };
  it('accepts authority results and rejects hidden fields, arithmetic errors and fake ranks', () => {
    expect(roundResultSchema.safeParse(result).success).toBe(true);
    expect(roundResultSchema.safeParse({ ...result, hand: [] }).success).toBe(
      false,
    );
    for (const change of [
      { delta: 99 },
      { multiplier: 4 },
      { playerId: 'B' },
      { rank: 2 },
      { hand: [] },
    ]) {
      expect(
        roundResultSchema.safeParse({
          ...result,
          participants: [
            { ...result.participants[0], ...change },
            result.participants[1],
          ],
        }).success,
      ).toBe(false);
    }
  });
  it('checks presentation chronology, queue membership and safe payloads', () => {
    const p = {
      id: '1-5',
      kind: 'refill',
      startsAt: new Date(0).toISOString(),
      dealsAt: new Date(0).toISOString(),
      readyAt: new Date(600).toISOString(),
      stepMs: 140,
      stockBefore: 3,
      beforeCounts: [
        { playerId: 'A', count: 6 },
        { playerId: 'B', count: 7 },
      ],
      recipients: ['A', 'A', 'B'],
    };
    expect(presentationSchema.safeParse(p).success).toBe(true);
    for (const change of [
      { readyAt: new Date(100).toISOString() },
      { stockBefore: 2 },
      { recipients: ['C'] },
      { stock: [] },
    ])
      expect(presentationSchema.safeParse({ ...p, ...change }).success).toBe(
        false,
      );
  });
});
