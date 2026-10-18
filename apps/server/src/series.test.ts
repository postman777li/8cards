import type { PlayerId, RoomSeries } from '@8cards/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseRoundMultiplier,
  finalizeSeries,
  resolveFourPlayerTeamOutcome,
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
    expect(
      four.participants.map((item) => [item.playerId, item.currentStreak]),
    ).toEqual([
      ['A', 1],
      ['B', 0],
      ['C', 1],
      ['D', 0],
    ]);
  });

  it('keeps a four-player team streak when alternating which teammate finishes first', () => {
    const teams = [
      [ids[0]!, ids[2]!],
      [ids[1]!, ids[3]!],
    ];
    const first = scoreRankedRound(
      series(4),
      4,
      ['A', 'B', 'C', 'D'] as PlayerId[],
      teams,
    );
    const second = scoreRankedRound(
      { ...first, phase: 'playing', roundNumber: 2 },
      4,
      ['C', 'D', 'A', 'B'] as PlayerId[],
      teams,
    );
    expect(
      second.participants.map((item) => [item.playerId, item.currentStreak]),
    ).toEqual([
      ['A', 2],
      ['B', 0],
      ['C', 2],
      ['D', 0],
    ]);
  });

  it('restores the original four-player teams after authority drops to three or two players', () => {
    const outcome = resolveFourPlayerTeamOutcome(
      ids,
      [
        [ids[0]!, ids[2]!],
        [ids[1]!, ids[3]!],
      ],
      new Set([ids[2]!]),
    );
    expect([...outcome.losers]).toEqual(['A', 'C']);
    expect([...outcome.winners]).toEqual(['B', 'D']);
    const scored = scoreSeriesRound(
      series(4),
      4,
      outcome.winners,
      outcome.losers,
    );
    expect(scored.participants.map((item) => item.score)).toEqual([
      -1, 1, -1, 1,
    ]);
    expect(scored.participants.reduce((sum, item) => sum + item.score, 0)).toBe(
      0,
    );
  });

  it('starts eggs at round three, uses 40% boundary, and eggs override streaks', () => {
    expect(chooseRoundMultiplier(2, true, () => 0)).toEqual({
      multiplier: 2,
      multiplierReason: 'winning-streak',
    });
    const values = [0.399999999, 0.8];
    expect(chooseRoundMultiplier(3, true, () => values.shift()!)).toEqual({
      multiplier: 4,
      multiplierReason: 'easter-egg',
    });
    expect(chooseRoundMultiplier(3, false, () => 0.4)).toEqual({
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

describe('task 23 authoritative round results', () => {
  it.each([2, 3, 4] as const)(
    'publishes complete %i-player placements and multiplied zero-sum deltas',
    (count) => {
      const before = series(count, 3);
      const result = scoreRankedRound(
        before,
        count,
        ids.slice(0, count),
        count === 4
          ? [
              [ids[0]!, ids[2]!],
              [ids[1]!, ids[3]!],
            ]
          : undefined,
      ).lastRoundResult!;
      expect(result.participants.map((p) => p.rank)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
      expect(result.participants.reduce((s, p) => s + p.delta, 0)).toBe(0);
      for (const p of result.participants) {
        expect(p.delta).toBe(p.baseScore * 3);
        expect(p.totalScore).toBe(p.delta);
      }
    },
  );
  it.each([2, 3, 4] as const)(
    'uses competition ties for %i-player joker/exit results',
    (count) => {
      const losers = new Set(
        count === 4 ? [ids[1]!, ids[3]!] : [ids[count - 1]!],
      );
      const winners = new Set(
        ids.slice(0, count).filter((id) => !losers.has(id)),
      );
      for (const reason of ['stuck-with-jokers', 'forfeit'] as const) {
        const after = scoreSeriesRound(
          series(count, 4),
          count,
          winners,
          losers,
          reason,
        );
        expect(
          after.lastRoundResult!.participants.map((p) => p.rank).sort(),
        ).toEqual(
          count === 2 ? [1, 2] : count === 3 ? [1, 1, 3] : [1, 1, 3, 3],
        );
        expect(
          after.lastRoundResult!.participants.reduce((s, p) => s + p.delta, 0),
        ).toBe(0);
        expect(finalizeSeries(after).lastRoundResult).toEqual(
          after.lastRoundResult,
        );
      }
    },
  );
  it.each([
    [0, 2],
    [1 / 3, 3],
    [2 / 3, 4],
    [0.999999, 4],
  ] as const)('chooses equal multiplier thirds at %f', (value, multiplier) => {
    const values = [0.399999999, value];
    expect(
      chooseRoundMultiplier(3, true, () => values.shift()!).multiplier,
    ).toBe(multiplier);
  });
});
