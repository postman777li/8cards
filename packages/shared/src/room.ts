import { z } from 'zod';
import { playerIdSchema, roomIdSchema, spectatorIdSchema } from './common.js';

export const playerCountSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export const seatIndexSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export const nicknameSchema = z.string().trim().min(1).max(24);
export const avatarIdSchema = z.enum([
  'default',
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
  'avatar-9',
]);
export const roomNameSchema = z.string().trim().min(1).max(40);
export const roomCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/);
export const roomConfigSchema = z.strictObject({
  playerCount: playerCountSchema,
  allowSpectators: z.boolean(),
  allowChat: z.boolean(),
  turnTimeoutSeconds: z.literal(20),
});
export const publicPlayerSchema = z.strictObject({
  identity: z.literal('player'),
  playerId: playerIdSchema,
  nickname: nicknameSchema,
  avatarId: avatarIdSchema.optional(),
  seat: seatIndexSchema,
  isHost: z.boolean(),
  connection: z.enum(['online', 'disconnected']),
  readiness: z.enum(['not-ready', 'ready']),
});
export const publicSpectatorSchema = z.strictObject({
  identity: z.literal('spectator'),
  spectatorId: spectatorIdSchema,
  nickname: nicknameSchema,
  avatarId: avatarIdSchema.optional(),
  connection: z.enum(['online', 'disconnected']),
});
export const roomPublicStateSchema = z.strictObject({
  roomId: roomIdSchema,
  name: roomNameSchema,
  code: roomCodeSchema,
  config: roomConfigSchema,
  players: z.array(publicPlayerSchema).max(4),
  spectators: z.array(publicSpectatorSchema),
});
export type PlayerCount = z.infer<typeof playerCountSchema>;
export type AvatarId = z.infer<typeof avatarIdSchema>;
export type SeatIndex = z.infer<typeof seatIndexSchema>;
export type RoomConfig = z.infer<typeof roomConfigSchema>;
export type PublicPlayer = z.infer<typeof publicPlayerSchema>;
export type PublicSpectator = z.infer<typeof publicSpectatorSchema>;
export type RoomPublicState = z.infer<typeof roomPublicStateSchema>;
export type ClientIdentity = PublicPlayer | PublicSpectator;
