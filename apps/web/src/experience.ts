import type { GamePublicState, PlayerId, RoomSeries } from '@8cards/shared';

export const QUICK_PHRASES = [
  '你的牌打得也太好了！',
  '快点吧，我等到花儿都谢了。',
  '别急，让我想想。',
  '这局有点意思。',
  '合作愉快！',
  '承让承让。',
] as const;

export const REACTIONS = [
  'like',
  'clap',
  'laugh',
  'think',
  'wow',
  'cheer',
  'facepalm',
] as const;
export type ReactionId = (typeof REACTIONS)[number];

export const reactionLabel: Record<ReactionId, string> = {
  like: '点赞',
  clap: '鼓掌',
  laugh: '大笑',
  think: '思考',
  wow: '惊讶',
  cheer: '加油',
  facepalm: '捂脸',
};

export interface DrawMotion {
  playerId: PlayerId;
  count: number;
  privateCards: boolean;
}

export function describeDraws(
  previous: GamePublicState,
  next: GamePublicState,
  viewer: PlayerId,
): DrawMotion[] {
  if (next.stockCount >= previous.stockCount) return [];
  return next.players.flatMap((player) => {
    const before =
      previous.players.find((item) => item.playerId === player.playerId)
        ?.handCount ?? player.handCount;
    const count = Math.max(0, player.handCount - before);
    return count
      ? [
          {
            playerId: player.playerId,
            count,
            privateCards: player.playerId === viewer,
          },
        ]
      : [];
  });
}

export type RankedParticipant = RoomSeries['participants'][number] & {
  rank: number;
};

export function rankParticipants(
  participants: RoomSeries['participants'],
): RankedParticipant[] {
  const sorted = [...participants].sort((a, b) => b.score - a.score);
  let previousScore: number | undefined;
  let previousRank = 0;
  return sorted.map((item, index) => {
    const rank = previousScore === item.score ? previousRank : index + 1;
    previousScore = item.score;
    previousRank = rank;
    return { ...item, rank };
  });
}
