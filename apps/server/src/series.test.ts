import type { PlayerId, RoomSeries } from '@8cards/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseRoundMultiplier,
  finalizeSeries,
  scoreRankedRound,
  scoreSeriesRound,
} from './series.js';

const ids = ['A', 'B', 'C', 'D'] as PlayerId[];
const series = (
  count: 2 | 3 | 4,
  multiplier: 1 | 2 | 3 | 4 = 1,
): RoomSeries => ({
  phase: 'playing',
  roundNumber: 1,
  multiplier,
  multiplierReason: 'normal',
  participants: ids.slice(0, count).map((playerId) => ({
    playerId,
    score: 0,
    wins: 0,
    losses: 0,
    longestStreak: 0,
    currentStreak: 0,
    titles: [],
  })),
  continueVotes: ids
    .slice(0, count)
    .map((playerId) => ({ playerId, choice: 'pending' })),
});

describe('room series scoring and multipliers', () => {
  it.each([
    [2, ['A'], ['B'], [1, -1]],
    [3, ['A'], ['B', 'C'], [2, -1, -1]],
    [4, ['A', 'C'], ['B', 'D'], [1, -1, 1, -1]],
  ] as const)(
    'keeps %i-player base scoring zero sum',
    (count, winners, losers, expected) => {
      const scored = scoreSeriesRound(
        series(count),
        count,
        new Set(winners as unknown as PlayerId[]),
        new Set(losers as unknown as PlayerId[]),
      );
      expect(scored.participants.map((item) => item.score)).toEqual(expected);
      expect(
        scored.participants.reduce((sum, item) => sum + item.score, 0),
      ).toBe(0);
    },
  );

  it('applies the published multiplier to every delta', () => {
    expect(
      scoreSeriesRound(
        series(3, 4),
        3,
        new Set([ids[0]!]),
        new Set([ids[1]!, ids[2]!]),
      ).participants.map((item) => item.score),
    ).toEqual([8, -4, -4]);
  });

  it('scores three-player placement and additive four-player team plus remaining placement', () => {
    expect(
      scoreRankedRound(series(3), 3, ids.slice(0, 3)).participants.map(
        (item) => item.score,
      ),
    ).toEqual([1, 0, -1]);
    const four = scoreRankedRound(
      series(4),
      4,
      ['A', 'B', 'C', 'D'] as PlayerId[],
      [
        [ids[0]!, ids[2]!],
        [ids[1]!, ids[3]!],
      ],
    );
    expect(four.participants.map((item) => item.score)).toEqual([1, 0, 1, -2]);
    expect(four.participants.reduce((sum, item) => sum + item.score, 0)).toBe(
      0,
    );
  });

  it('starts eggs at round three, uses 25% boundary, and eggs override streaks', () => {
    expect(chooseRoundMultiplier(2, true, () => 0)).toEqual({
      multiplier: 2,
      multiplierReason: 'winning-streak',
    });
    const values = [0.249999, 0.8];
    expect(chooseRoundMultiplier(3, true, () => values.shift()!)).toEqual({
      multiplier: 4,
      multiplierReason: 'easter-egg',
    });
    expect(chooseRoundMultiplier(3, false, () => 0.25)).toEqual({
      multiplier: 1,
      multiplierReason: 'normal',
    });
  });

  it('shares first place and longest streak titles on ties', () => {
    const done = finalizeSeries({
      ...series(2),
      participants: series(2).participants.map((item) => ({
        ...item,
        score: 3,
        longestStreak: 2,
      })),
    });
    expect(
      done.participants.every(
        (item) =>
          item.titles.includes('嘉豪之王') && item.titles.includes('常胜将军'),
      ),
    ).toBe(true);
  });
});
