import { z } from 'zod';

const identifier = (name: string) =>
  z.string().trim().min(1).max(128).brand(name);

export const playerIdSchema = identifier('PlayerId');
export const roomIdSchema = identifier('RoomId');
export const gameIdSchema = identifier('GameId');
export const connectionIdSchema = identifier('ConnectionId');
export const requestIdSchema = identifier('RequestId');
export const spectatorIdSchema = identifier('SpectatorId');
export const visitorIdSchema = identifier('VisitorId');
export type PlayerId = z.infer<typeof playerIdSchema>;
export type RoomId = z.infer<typeof roomIdSchema>;
export type GameId = z.infer<typeof gameIdSchema>;
export type ConnectionId = z.infer<typeof connectionIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type SpectatorId = z.infer<typeof spectatorIdSchema>;
export type VisitorId = z.infer<typeof visitorIdSchema>;

export const protocolVersionSchema = z.literal(1);
export const PROTOCOL_VERSION = protocolVersionSchema.value;
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
export const stateVersionSchema = z.number().int().nonnegative();
export const actionSequenceSchema = z.number().int().positive();
export const timestampSchema = z.string().datetime({ offset: true });
export type StateVersion = z.infer<typeof stateVersionSchema>;
export type ActionSequence = z.infer<typeof actionSequenceSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;

export const errorCodeSchema = z.enum([
  'MALFORMED_MESSAGE',
  'UNAUTHORIZED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'WRONG_ACTOR',
  'ILLEGAL_ACTION',
  'STALE_STATE',
  'DUPLICATE_REQUEST',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'SPECTATOR_FULL',
  'PERSISTENCE_PENDING',
]);
export const protocolErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  details: z.record(z.string(), z.string()).optional(),
});
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
