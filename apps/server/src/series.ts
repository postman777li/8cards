import type { PlayerId, RoomSeries } from '@8cards/shared';

export function chooseRoundMultiplier(
  roundNumber: number,
  winningStreak: boolean,
  random: () => number,
): Pick<RoomSeries, 'multiplier' | 'multiplierReason'> {
  let multiplier: 1 | 2 | 3 | 4 = winningStreak ? 2 : 1;
  let multiplierReason: RoomSeries['multiplierReason'] = winningStreak
    ? 'winning-streak'
    : 'normal';
  if (roundNumber >= 3 && random() < 0.25) {
    const value = random();
    multiplier = value < 1 / 3 ? 2 : value < 2 / 3 ? 3 : 4;
    multiplierReason = 'easter-egg';
  }
  return { multiplier, multiplierReason };
}

export function scoreSeriesRound(
  series: RoomSeries,
  playerCount: 2 | 3 | 4,
  winners: ReadonlySet<PlayerId>,
  losers: ReadonlySet<PlayerId>,
): RoomSeries {
  const splitThreeWin = playerCount === 3 && winners.size === 2;
  return {
    ...series,
    phase: 'continue-vote',
    participants: series.participants.map((item) => {
      const won = winners.has(item.playerId);
      const lost = losers.has(item.playerId) || (!won && winners.size > 0);
      const base = won
        ? playerCount === 3
          ? splitThreeWin
            ? 1
            : 2
          : 1
        : lost
          ? playerCount === 3 && splitThreeWin
            ? -2
            : -1
          : 0;
      const currentStreak = won ? item.currentStreak + 1 : 0;
      return {
        ...item,
        score: item.score + base * series.multiplier,
        wins: item.wins + (won ? 1 : 0),
        losses: item.losses + (lost ? 1 : 0),
        currentStreak,
        longestStreak: Math.max(item.longestStreak, currentStreak),
      };
    }),
    continueVotes: series.continueVotes.map((item) => ({
      ...item,
      choice: 'pending',
    })),
  };
}

export function scoreRankedRound(
  series: RoomSeries,
  playerCount: 2 | 3 | 4,
  finishOrder: readonly PlayerId[],
  teams?: readonly (readonly PlayerId[])[],
): RoomSeries {
  const delta = new Map<PlayerId, number>(
    series.participants.map((item) => [item.playerId, 0]),
  );
  if (playerCount === 2) {
    delta.set(finishOrder[0]!, 1);
    delta.set(finishOrder[1]!, -1);
  } else if (playerCount === 3) {
    [1, 0, -1].forEach((score, index) => delta.set(finishOrder[index]!, score));
  } else {
    const first = finishOrder[0]!;
    const firstTeam = teams?.find((team) => team.includes(first)) ?? [first];
    for (const item of series.participants)
      delta.set(item.playerId, firstTeam.includes(item.playerId) ? 1 : -1);
    [1, 0, -1].forEach((score, index) => {
      const player = finishOrder[index + 1]!;
      delta.set(player, (delta.get(player) ?? 0) + score);
    });
  }
  const firstTeam =
    playerCount === 4
      ? (teams?.find((team) => team.includes(finishOrder[0]!)) ?? [
          finishOrder[0]!,
        ])
      : [finishOrder[0]!];
  return {
    ...series,
    phase: 'continue-vote',
    participants: series.participants.map((item) => {
      const placement = finishOrder.indexOf(item.playerId);
      const won = firstTeam.includes(item.playerId);
      const lost =
        playerCount === 4 ? !won : placement === finishOrder.length - 1;
      const currentStreak = won ? item.currentStreak + 1 : 0;
      return {
        ...item,
        score: item.score + (delta.get(item.playerId) ?? 0) * series.multiplier,
        wins: item.wins + (won ? 1 : 0),
        losses: item.losses + (lost ? 1 : 0),
        currentStreak,
        longestStreak: Math.max(item.longestStreak, currentStreak),
      };
    }),
    continueVotes: series.continueVotes.map((item) => ({
      ...item,
      choice: 'pending',
    })),
  };
}

export function resolveFourPlayerTeamOutcome(
  participantIds: readonly PlayerId[],
  teams: readonly (readonly PlayerId[])[],
  losingPlayers: ReadonlySet<PlayerId>,
) {
  const losingTeam = teams.find((team) =>
    team.some((player) => losingPlayers.has(player)),
  );
  const losers = new Set<PlayerId>(losingTeam ?? losingPlayers);
  const winners = new Set(
    participantIds.filter((playerId) => !losers.has(playerId)),
  );
  return { winners, losers };
}

export function finalizeSeries(series: RoomSeries): RoomSeries {
  const bestScore = Math.max(...series.participants.map((item) => item.score));
  const bestStreak = Math.max(
    ...series.participants.map((item) => item.longestStreak),
  );
  return {
    ...series,
    phase: 'series-result',
    participants: series.participants.map((item) => ({
      ...item,
      titles: [
        ...(item.score === bestScore ? (['嘉豪之王'] as const) : []),
        ...(bestStreak > 0 && item.longestStreak === bestStreak
          ? (['常胜将军'] as const)
          : []),
      ],
    })),
  };
}
