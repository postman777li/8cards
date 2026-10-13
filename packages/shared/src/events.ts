import { z } from 'zod';
import { cardIdSchema } from './cards.js';
import {
  actionSequenceSchema,
  playerIdSchema,
  protocolErrorSchema,
  protocolVersionSchema,
  requestIdSchema,
  stateVersionSchema,
  timestampSchema,
  roomIdSchema,
} from './common.js';
import {
  playerViewSchema,
  publicSnapshotSchema,
  spectatorViewSchema,
} from './game-state.js';
import {
  nicknameSchema,
  roomCodeSchema,
  roomConfigSchema,
  roomNameSchema,
} from './room.js';

const requestMeta = {
  protocolVersion: protocolVersionSchema,
  requestId: requestIdSchema,
  actionSequence: actionSequenceSchema,
};
const versionedRequestMeta = {
  ...requestMeta,
  expectedStateVersion: stateVersionSchema,
};
const createRoomEventSchema = z.strictObject({
  type: z.literal('room.create'),
  ...requestMeta,
  nickname: nicknameSchema,
  roomName: roomNameSchema,
  config: roomConfigSchema,
});
const joinRoomEventSchema = z.strictObject({
  type: z.literal('room.join'),
  ...requestMeta,
  nickname: nicknameSchema,
  roomCode: roomCodeSchema,
});
const resumeSessionEventSchema = z.strictObject({
  type: z.literal('session.resume'),
  ...requestMeta,
  roomId: roomIdSchema,
  playerId: playerIdSchema,
  reconnectToken: z.string().min(32).max(256),
});
const leaveRoomEventSchema = z.strictObject({
  type: z.literal('room.leave'),
  ...versionedRequestMeta,
});
const readyEventSchema = z.strictObject({
  type: z.literal('room.ready'),
  ...versionedRequestMeta,
  ready: z.boolean(),
});
const startEventSchema = z.strictObject({
  type: z.literal('room.start'),
  ...versionedRequestMeta,
});
const chatEventSchema = z.strictObject({
  type: z.literal('chat.send'),
  ...versionedRequestMeta,
  message: z.string().trim().min(1).max(300),
});
const spectateJoinEventSchema = z.strictObject({
  type: z.literal('spectate.join'),
  ...requestMeta,
  nickname: nicknameSchema,
  roomCode: roomCodeSchema,
});
const spectateLeaveEventSchema = z.strictObject({
  type: z.literal('spectate.leave'),
  ...versionedRequestMeta,
});
export const gameActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('play-card'), cardId: cardIdSchema }),
  z.strictObject({
    kind: z.literal('beat-card'),
    cardId: cardIdSchema,
    targetCardId: cardIdSchema,
  }),
  z.strictObject({ kind: z.literal('pass') }),
  z.strictObject({ kind: z.literal('collect') }),
  z.strictObject({ kind: z.literal('exchange-trump-two') }),
]);
const gameActionEventSchema = z.strictObject({
  type: z.literal('game.action'),
  ...versionedRequestMeta,
  action: gameActionSchema,
});
export const clientEventSchema = z.discriminatedUnion('type', [
  createRoomEventSchema,
  joinRoomEventSchema,
  resumeSessionEventSchema,
  leaveRoomEventSchema,
  readyEventSchema,
  startEventSchema,
  chatEventSchema,
  spectateJoinEventSchema,
  spectateLeaveEventSchema,
  gameActionEventSchema,
]);

const responseOkSchema = z.strictObject({
  type: z.literal('response.ok'),
  protocolVersion: protocolVersionSchema,
  requestId: requestIdSchema,
  stateVersion: stateVersionSchema,
});
const responseErrorSchema = z.strictObject({
  type: z.literal('response.error'),
  protocolVersion: protocolVersionSchema,
  requestId: requestIdSchema,
  error: protocolErrorSchema,
});
export const sessionEstablishedEventSchema = z.strictObject({
  type: z.literal('session.established'),
  protocolVersion: protocolVersionSchema,
  roomId: roomIdSchema,
  playerId: playerIdSchema,
  reconnectToken: z.string().min(32).max(256),
});
const playerSnapshotEventSchema = z.strictObject({
  type: z.literal('state.player'),
  protocolVersion: protocolVersionSchema,
  stateVersion: stateVersionSchema,
  view: playerViewSchema,
});
const spectatorSnapshotEventSchema = z.strictObject({
  type: z.literal('state.spectator'),
  protocolVersion: protocolVersionSchema,
  stateVersion: stateVersionSchema,
  view: spectatorViewSchema,
});
export const individualServerEventSchema = z.discriminatedUnion('type', [
  responseOkSchema,
  responseErrorSchema,
  sessionEstablishedEventSchema,
  playerSnapshotEventSchema,
  spectatorSnapshotEventSchema,
]);
const publicStateEventSchema = z.strictObject({
  type: z.literal('state.public'),
  protocolVersion: protocolVersionSchema,
  stateVersion: stateVersionSchema,
  snapshot: publicSnapshotSchema,
});
const publicChatEventSchema = z.strictObject({
  type: z.literal('chat.message'),
  protocolVersion: protocolVersionSchema,
  stateVersion: stateVersionSchema,
  messageId: z.string().trim().min(1).max(128),
  senderPlayerId: playerIdSchema.optional(),
  senderNickname: nicknameSchema,
  message: z.string().min(1).max(300),
  sentAt: timestampSchema,
});
export const publicServerEventSchema = z.discriminatedUnion('type', [
  publicStateEventSchema,
  publicChatEventSchema,
]);
export const serverEventSchema = z.union([
  individualServerEventSchema,
  publicServerEventSchema,
]);
export type GameAction = z.infer<typeof gameActionSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type IndividualServerEvent = z.infer<typeof individualServerEventSchema>;
export type PublicServerEvent = z.infer<typeof publicServerEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export const parseClientEvent = (input: unknown): ClientEvent =>
  clientEventSchema.parse(input);
export const parseServerEvent = (input: unknown): ServerEvent =>
  serverEventSchema.parse(input);
export const safeParseClientEvent = (input: unknown) =>
  clientEventSchema.safeParse(input);
export const safeParseServerEvent = (input: unknown) =>
  serverEventSchema.safeParse(input);
