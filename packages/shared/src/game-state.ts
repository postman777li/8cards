import { z } from 'zod';
import { cardSchema, suitSchema } from './cards.js';
import {
  gameIdSchema,
  playerIdSchema,
  stateVersionSchema,
  timestampSchema,
} from './common.js';
import { roomPublicStateSchema } from './room.js';

export const gamePhaseSchema = z.enum([
  'drawing',
  'attacking',
  'defending',
  'refilling',
  'finished',
]);
export const playerRoleSchema = z.enum(['attacker', 'defender', 'observer']);
export const teamSchema = z.enum(['team-a', 'team-b', 'solo']);
export const publicGamePlayerSchema = z.strictObject({
  playerId: playerIdSchema,
  handCount: z.number().int().nonnegative().max(54),
  role: playerRoleSchema,
  team: teamSchema,
});
export const tablePlaySchema = z.strictObject({
  playerId: playerIdSchema,
  card: cardSchema,
  purpose: z.enum(['attack', 'defense']),
});
export const gamePublicStateSchema = z.strictObject({
  gameId: gameIdSchema,
  phase: gamePhaseSchema,
  trumpSuit: suitSchema.nullable(),
  exposedCard: cardSchema.nullable(),
  stockCount: z.number().int().nonnegative().max(54),
  table: z.array(tablePlaySchema).max(54),
  players: z.array(publicGamePlayerSchema).min(2).max(4),
  currentActorId: playerIdSchema.nullable(),
  attackerId: playerIdSchema.nullable(),
  defenderId: playerIdSchema.nullable(),
  turnDeadline: timestampSchema.nullable(),
  winnerPlayerIds: z.array(playerIdSchema).max(2).optional(),
  loserPlayerIds: z.array(playerIdSchema).max(2).optional(),
  resultReason: z.enum(['emptied-hand', 'stuck-with-jokers']).optional(),
});
export const seriesParticipantSchema = z.strictObject({
  playerId: playerIdSchema,
  score: z.number().int(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  longestStreak: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  titles: z.array(z.enum(['嘉豪之王', '常胜将军', '快刀手', '滴水不漏'])),
});
export const roundResultSchema = z
  .strictObject({
    roundNumber: z.number().int().positive(),
    reason: z.enum(['emptied-hand', 'stuck-with-jokers', 'forfeit']),
    participants: z
      .array(
        z.strictObject({
          playerId: playerIdSchema,
          rank: z.number().int().min(1).max(4),
          baseScore: z.number().int(),
          multiplier: z.number().int().min(1).max(4),
          delta: z.number().int(),
          totalScore: z.number().int(),
          outcome: z.enum(['win', 'loss', 'unresolved']),
        }),
      )
      .min(2)
      .max(4),
  })
  .superRefine((value, context) => {
    const rows = value.participants;
    const ranks = rows.map((row) => row.rank).sort((a, b) => a - b);
    if (
      new Set(rows.map((row) => row.playerId)).size !== rows.length ||
      rows.some(
        (row) =>
          row.delta !== row.baseScore * row.multiplier ||
          row.multiplier !== rows[0]!.multiplier,
      ) ||
      rows.reduce((sum, row) => sum + row.delta, 0) !== 0 ||
      ranks.some(
        (rank, index) =>
          rank !==
          (index > 0 && ranks[index - 1] === rank
            ? ranks[index - 1]
            : index + 1),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Round result must have unique players, competition ranks and zero-sum multiplied scores',
      });
    }
  });
export const presentationSchema = z
  .strictObject({
    id: z.string().max(100),
    kind: z.enum(['initial', 'refill']),
    startsAt: timestampSchema,
    dealsAt: timestampSchema,
    readyAt: timestampSchema,
    stepMs: z.number().int().min(40).max(500),
    stockBefore: z.number().int().min(0).max(54),
    beforeCounts: z
      .array(
        z.strictObject({
          playerId: playerIdSchema,
          count: z.number().int().min(0).max(54),
        }),
      )
      .max(4),
    recipients: z.array(playerIdSchema).max(54),
  })
  .superRefine((value, context) => {
    if (
      Date.parse(value.dealsAt) < Date.parse(value.startsAt) ||
      Date.parse(value.readyAt) <
        Date.parse(value.dealsAt) + value.recipients.length * value.stepMs ||
      value.stockBefore < value.recipients.length ||
      new Set(value.beforeCounts.map((row) => row.playerId)).size !==
        value.beforeCounts.length ||
      value.recipients.some(
        (id) => !value.beforeCounts.some((row) => row.playerId === id),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid authoritative presentation sequence or time boundary',
      });
    }
  });
export const roomSeriesSchema = z.strictObject({
  phase: z.enum(['playing', 'continue-vote', 'series-result']),
  roundNumber: z.number().int().positive(),
  multiplier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  multiplierReason: z.enum(['normal', 'winning-streak', 'easter-egg']),
  participants: z.array(seriesParticipantSchema).min(2).max(4),
  continueVotes: z
    .array(
      z.strictObject({
        playerId: playerIdSchema,
        choice: z.enum(['pending', 'continue', 'stop']),
      }),
    )
    .min(2)
    .max(4),
  finishOrder: z.array(playerIdSchema).max(4).optional(),
  lastRoundResult: roundResultSchema.optional(),
  presentation: presentationSchema.optional(),
});
export const publicSnapshotSchema = z.strictObject({
  stateVersion: stateVersionSchema,
  room: roomPublicStateSchema,
  game: gamePublicStateSchema.nullable(),
  series: roomSeriesSchema.optional(),
});
export const playerPrivateStateSchema = z.strictObject({
  hand: z.array(cardSchema).max(54),
  legalActionTypes: z.array(
    z.enum(['play-card', 'beat-card', 'pass', 'collect', 'exchange-trump-two']),
  ),
});
export const playerViewSchema = z.strictObject({
  audience: z.literal('player'),
  viewerPlayerId: playerIdSchema,
  public: publicSnapshotSchema,
  private: playerPrivateStateSchema,
});
export const opponentViewSchema = z.strictObject({
  audience: z.literal('opponent'),
  public: publicSnapshotSchema,
});
export const spectatorViewSchema = z.strictObject({
  audience: z.literal('spectator'),
  public: publicSnapshotSchema,
});
export type GamePhase = z.infer<typeof gamePhaseSchema>;
export type PlayerRole = z.infer<typeof playerRoleSchema>;
export type Team = z.infer<typeof teamSchema>;
export type GamePublicState = z.infer<typeof gamePublicStateSchema>;
export type RoomSeries = z.infer<typeof roomSeriesSchema>;
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;
export type PlayerPrivateState = z.infer<typeof playerPrivateStateSchema>;
export type PlayerView = z.infer<typeof playerViewSchema>;
export type OpponentView = z.infer<typeof opponentViewSchema>;
export type SpectatorView = z.infer<typeof spectatorViewSchema>;
