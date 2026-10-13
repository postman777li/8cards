import type { PlayerId } from '@8cards/shared';

export type SettlementOutcome = 'win' | 'loss' | 'unresolved';

export function settlementOutcome(
  playerCount: 2 | 3 | 4,
  playerId: PlayerId,
  winnerIds: ReadonlySet<PlayerId>,
  loserIds: ReadonlySet<PlayerId>,
): SettlementOutcome {
  if (winnerIds.has(playerId)) return 'win';
  if (loserIds.has(playerId) || playerCount === 2) return 'loss';
  return 'unresolved';
}
