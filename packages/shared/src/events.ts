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
  spectatorIdSchema,
  visitorIdSchema,
} from './common.js';
import {
  roundResultSchema,
  playerViewSchema,
  publicSnapshotSchema,
  spectatorViewSchema,
} from './game-state.js';
import {
  nicknameSchema,
  avatarIdSchema,
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
  avatarId: avatarIdSchema.optional(),
  roomName: roomNameSchema,
  config: roomConfigSchema,
  visitorId: visitorIdSchema.optional(),
});
const joinRoomEventSchema = z.strictObject({
  type: z.literal('room.join'),
  ...requestMeta,
  nickname: nicknameSchema,
  avatarId: avatarIdSchema.optional(),
  roomCode: roomCodeSchema,
  visitorId: visitorIdSchema.optional(),
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
const seatRequestEventSchema = z.strictObject({
  type: z.literal('room.seat.request'),
  ...versionedRequestMeta,
  targetSeat: z.number().int().min(0).max(3),
});
const seatRespondEventSchema = z.strictObject({
  type: z.literal('room.seat.respond'),
  ...versionedRequestMeta,
  seatRequestId: z.string().min(1).max(128),
  accept: z.boolean(),
});
const chatEventSchema = z.strictObject({
  type: z.literal('chat.send'),
  ...versionedRequestMeta,
  message: z.string().trim().min(1).max(300),
});
export const reactionIdSchema = z.enum([
  'like',
  'clap',
  'laugh',
  'think',
  'wow',
  'cheer',
  'facepalm',
]);
const reactionEventSchema = z.strictObject({
  type: z.literal('reaction.send'),
  ...versionedRequestMeta,
  reactionId: reactionIdSchema,
});
const spectateJoinEventSchema = z.strictObject({
  type: z.literal('spectate.join'),
  ...requestMeta,
  nickname: nicknameSchema,
  avatarId: avatarIdSchema.optional(),
  roomCode: roomCodeSchema,
  visitorId: visitorIdSchema,
});
const spectateResumeEventSchema = z.strictObject({
  type: z.literal('spectate.resume'),
  ...requestMeta,
  roomId: roomIdSchema,
  spectatorId: spectatorIdSchema,
  reconnectToken: z.string().min(32).max(256),
  visitorId: visitorIdSchema,
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
const seriesContinueEventSchema = z.strictObject({
  type: z.literal('series.continue'),
  ...versionedRequestMeta,
  continue: z.boolean(),
});
const seriesExitEventSchema = z.strictObject({
  type: z.literal('series.exit'),
  ...versionedRequestMeta,
});
const historyGetEventSchema = z.strictObject({
  type: z.literal('history.get'),
  ...requestMeta,
});
export const clientEventSchema = z.discriminatedUnion('type', [
  createRoomEventSchema,
  joinRoomEventSchema,
  resumeSessionEventSchema,
  leaveRoomEventSchema,
  readyEventSchema,
  startEventSchema,
  seatRequestEventSchema,
  seatRespondEventSchema,
  chatEventSchema,
  reactionEventSchema,
  spectateJoinEventSchema,
  spectateResumeEventSchema,
  spectateLeaveEventSchema,
  gameActionEventSchema,
  seriesContinueEventSchema,
  seriesExitEventSchema,
  historyGetEventSchema,
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
  visitorId: visitorIdSchema.optional(),
});
export const spectatorSessionEstablishedEventSchema = z.strictObject({
  type: z.literal('spectator.established'),
  protocolVersion: protocolVersionSchema,
  roomId: roomIdSchema,
  spectatorId: spectatorIdSchema,
  reconnectToken: z.string().min(32).max(256),
  visitorId: visitorIdSchema,
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
export const chatMessageSchema = z.strictObject({
  messageId: z.string().trim().min(1).max(128),
  senderPlayerId: playerIdSchema.optional(),
  senderSpectatorId: spectatorIdSchema.optional(),
  senderNickname: nicknameSchema,
  message: z.string().min(1).max(300),
  sentAt: timestampSchema,
  chatVersion: z.number().int().positive(),
});
const chatHistoryEventSchema = z.strictObject({
  type: z.literal('chat.history'),
  protocolVersion: protocolVersionSchema,
  messages: z.array(chatMessageSchema).max(100),
});
const participantResultSchema = z.strictObject({
  playerId: playerIdSchema,
  nickname: nicknameSchema,
  seat: z.number().int().min(0).max(3),
  team: z.enum(['team-a', 'team-b', 'solo']),
  outcome: z.enum(['win', 'loss', 'unresolved']),
});
export const gameRecordSchema = z.strictObject({
  gameId: z.string().min(1).max(128),
  roomName: roomNameSchema,
  playerCount: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  reason: z.enum(['emptied-hand', 'stuck-with-jokers', 'forfeit']),
  roundResult: roundResultSchema.optional(),
  participants: z.array(participantResultSchema).min(2).max(4),
});
const historyResultEventSchema = z.strictObject({
  type: z.literal('history.result'),
  protocolVersion: protocolVersionSchema,
  stats: z.strictObject({
    games: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  recent: z.array(gameRecordSchema).max(20),
  persistenceStatus: z.enum(['saved', 'pending']).optional(),
});
export const individualServerEventSchema = z.discriminatedUnion('type', [
  responseOkSchema,
  responseErrorSchema,
  sessionEstablishedEventSchema,
  spectatorSessionEstablishedEventSchema,
  playerSnapshotEventSchema,
  spectatorSnapshotEventSchema,
  chatHistoryEventSchema,
  historyResultEventSchema,
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
  senderSpectatorId: spectatorIdSchema.optional(),
  senderNickname: nicknameSchema,
  message: z.string().min(1).max(300),
  sentAt: timestampSchema,
  chatVersion: z.number().int().positive(),
});
const publicReactionEventSchema = z.strictObject({
  type: z.literal('reaction.show'),
  protocolVersion: protocolVersionSchema,
  stateVersion: stateVersionSchema,
  reactionEventId: z.string().trim().min(1).max(128),
  reactionId: reactionIdSchema,
  senderPlayerId: playerIdSchema.optional(),
  senderSpectatorId: spectatorIdSchema.optional(),
  sentAt: timestampSchema,
});
export const publicServerEventSchema = z.discriminatedUnion('type', [
  publicStateEventSchema,
  publicChatEventSchema,
  publicReactionEventSchema,
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
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ReactionId = z.infer<typeof reactionIdSchema>;
export type ReactionEvent = z.infer<typeof publicReactionEventSchema>;
export type GameRecord = z.infer<typeof gameRecordSchema>;
export const parseClientEvent = (input: unknown): ClientEvent =>
  clientEventSchema.parse(input);
export const parseServerEvent = (input: unknown): ServerEvent =>
  serverEventSchema.parse(input);
export const safeParseClientEvent = (input: unknown) =>
  clientEventSchema.safeParse(input);
export const safeParseServerEvent = (input: unknown) =>
  serverEventSchema.safeParse(input);
