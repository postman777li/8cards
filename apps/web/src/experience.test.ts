import { describe, expect, it } from 'vitest';
import type { GamePublicState, PlayerId, RoomSeries } from '@8cards/shared';
import { clampVolume } from './audio-system.js';
import { describeDraws, rankParticipants } from './experience.js';

const id = (value: string) => value as PlayerId;

describe('premium experience helpers', () => {
  it('clamps persisted audio volume safely', () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.42)).toBe(0.42);
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(0.45);
  });

  it('describes only public hand-count draw deltas and marks only the viewer private', () => {
    const game = (stockCount: number, counts: number[]) =>
      ({
        stockCount,
        players: counts.map((handCount, index) => ({
          playerId: id(`p${index}`),
          handCount,
        })),
      }) as GamePublicState;
    expect(describeDraws(game(20, [5, 6]), game(17, [7, 7]), id('p0'))).toEqual(
      [
        { playerId: 'p0', count: 2, privateCards: true },
        { playerId: 'p1', count: 1, privateCards: false },
      ],
    );
    expect(describeDraws(game(17, [7, 7]), game(17, [7, 7]), id('p0'))).toEqual(
      [],
    );
  });

  it('uses standard competition ranks for ties', () => {
    const participants = [10, 10, 5, 1].map((score, index) => ({
      playerId: id(`p${index}`),
      score,
      wins: 0,
      losses: 0,
      currentStreak: 0,
      longestStreak: 0,
      titles: [],
    })) as RoomSeries['participants'];
    expect(rankParticipants(participants).map((item) => item.rank)).toEqual([
      1, 1, 3, 4,
    ]);
  });
});
