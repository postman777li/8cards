import {
  playerViewSchema,
  publicSnapshotSchema,
  type Card,
  type GamePublicState,
  type GameId,
  type PlayerId,
  type PlayerView,
  type PublicSnapshot,
  type RoomSeries,
  spectatorViewSchema,
  type SpectatorView,
} from '@8cards/shared';
import type {
  FourPlayerState,
  ThreePlayerState,
  TwoPlayerState,
} from '@8cards/game-engine';

import type { RoomSnapshot } from './room-service.js';

export type AuthorityState =
  | {
      readonly mode: 2;
      readonly state: TwoPlayerState<PlayerId>;
      readonly attackOwners: readonly PlayerId[];
    }
  | {
      readonly mode: 3;
      readonly state: ThreePlayerState<PlayerId>;
      readonly attackOwners: readonly PlayerId[];
    }
  | {
      readonly mode: 4;
      readonly state: FourPlayerState<PlayerId>;
      readonly attackOwners: readonly PlayerId[];
    };

const gamePhase = (state: AuthorityState['state']) =>
  state.phase === 'finished'
    ? ('finished' as const)
    : state.phase === 'awaiting-attack'
      ? ('attacking' as const)
      : ('defending' as const);

const winnerIds = (authority: AuthorityState): PlayerId[] | undefined => {
  const { state } = authority;
  if (state.phase !== 'finished') return undefined;
  if (authority.mode === 2)
    return [
      (state as TwoPlayerState<PlayerId> & { phase: 'finished' }).result.winner,
    ];
  if (authority.mode === 3) {
    const result = (state as ThreePlayerState<PlayerId> & { phase: 'finished' })
      .result;
    return result.outcome === 'winner' ? [result.winner] : undefined;
  }
  return [
    ...(state as FourPlayerState<PlayerId> & { phase: 'finished' }).result
      .winningTeam.members,
  ];
};

const resultReason = (
  authority: AuthorityState,
): 'emptied-hand' | 'stuck-with-jokers' | undefined => {
  if (authority.state.phase !== 'finished') return undefined;
  return authority.state.result.reason === 'emptied-hand'
    ? 'emptied-hand'
    : 'stuck-with-jokers';
};

export const projectLoserIds = (
  authority: AuthorityState,
): PlayerId[] | undefined => {
  const { state } = authority;
  if (state.phase !== 'finished') return undefined;
  if (authority.mode === 3) {
    const result = (state as ThreePlayerState<PlayerId> & { phase: 'finished' })
      .result;
    return result.outcome === 'loser' ? [result.loser] : undefined;
  }
  if (authority.mode === 4)
    return [
      ...(state as FourPlayerState<PlayerId> & { phase: 'finished' }).result
        .losingTeam.members,
    ];
  return undefined;
};

const roles = (authority: AuthorityState, playerId: PlayerId) => {
  const { state } = authority;
  if (authority.mode === 2)
    return {
      role:
        playerId === state.defender
          ? ('defender' as const)
          : ('attacker' as const),
      team: 'solo' as const,
    };
  if (authority.mode === 3)
    return {
      role:
        playerId === state.defender
          ? ('defender' as const)
          : ('attacker' as const),
      team: 'solo' as const,
    };
  const four = state as FourPlayerState<PlayerId>;
  return {
    role:
      playerId === four.defender
        ? ('defender' as const)
        : playerId === four.observer
          ? ('observer' as const)
          : ('attacker' as const),
    team: four.teams[0].members.includes(playerId)
      ? ('team-a' as const)
      : ('team-b' as const),
  };
};

const projectGame = (
  authority: AuthorityState,
  room: RoomSnapshot,
  turnDeadline: string | null,
  roundNumber = 1,
): GamePublicState => {
  const { state } = authority;
  const winners = winnerIds(authority);
  const losers = projectLoserIds(authority);
  const reason = resultReason(authority);
  const attackPlayerId =
    authority.mode === 2
      ? authority.state.attacker
      : authority.state.roundAttacker;
  return {
    gameId: `game-${room.roomId}-${roundNumber}` as GameId,
    phase: gamePhase(state),
    trumpSuit: state.trumpSuit,
    exposedCard: state.bottomCard,
    stockCount: state.stock.length,
    table: state.table.flatMap((pair, index) => [
      {
        playerId: authority.attackOwners[index] ?? attackPlayerId,
        card: pair.attack,
        purpose: 'attack' as const,
      },
      ...(pair.defense
        ? [
            {
              playerId: state.defender,
              card: pair.defense,
              purpose: 'defense' as const,
            },
          ]
        : []),
    ]),
    players: [
      ...state.players.map((playerId) => ({
        playerId,
        handCount: state.hands.get(playerId)?.length ?? 0,
        ...roles(authority, playerId),
      })),
      ...room.players
        .filter((player) => !state.players.includes(player.playerId))
        .map((player) => ({
          playerId: player.playerId,
          handCount: 0,
          role: 'observer' as const,
          team:
            room.config.playerCount === 4
              ? player.seat % 2 === 0
                ? ('team-a' as const)
                : ('team-b' as const)
              : ('solo' as const),
        })),
    ],
    currentActorId: state.actor,
    attackerId:
      authority.mode === 2
        ? (state as TwoPlayerState<PlayerId>).attacker
        : (state as ThreePlayerState<PlayerId> | FourPlayerState<PlayerId>)
            .roundAttacker,
    defenderId: state.defender,
    turnDeadline,
    ...(winners ? { winnerPlayerIds: winners } : {}),
    ...(losers ? { loserPlayerIds: losers } : {}),
    ...(reason ? { resultReason: reason } : {}),
  };
};

export const projectPublicSnapshot = (
  room: RoomSnapshot,
  stateVersion: number,
  authority?: AuthorityState,
  turnDeadline: string | null = null,
  series?: RoomSeries,
): PublicSnapshot =>
  publicSnapshotSchema.parse({
    stateVersion,
    room: {
      roomId: room.roomId,
      name: room.name,
      code: room.code,
      config: room.config,
      players: room.players,
      spectators: room.spectators,
      seatSwapRequest: room.seatSwapRequest ?? null,
    },
    game: authority
      ? projectGame(authority, room, turnDeadline, series?.roundNumber)
      : null,
    ...(series ? { series } : {}),
  });

const legalActions = (
  authority: AuthorityState | undefined,
  playerId: PlayerId,
) => {
  if (!authority || authority.state.phase === 'finished') return [];
  const { state } = authority;
  const result: Array<
    'play-card' | 'beat-card' | 'pass' | 'collect' | 'exchange-trump-two'
  > = [];
  if (
    !state.indicatorExchanged &&
    state.stock.length > 0 &&
    state.hands
      .get(playerId)
      ?.some(
        (card) =>
          card.kind === 'standard' &&
          card.suit === state.trumpSuit &&
          card.rank === '2',
      )
  )
    result.push('exchange-trump-two');
  if (playerId === state.defender && state.table.length > 0)
    result.push('collect');
  if (state.actor === playerId) {
    if (state.phase === 'awaiting-defense') result.push('beat-card');
    else {
      result.push('play-card');
      if (state.table.length > 0) result.push('pass');
    }
  }
  return result;
};

export const projectPlayerView = (
  room: RoomSnapshot,
  stateVersion: number,
  playerId: PlayerId,
  authority?: AuthorityState,
  turnDeadline: string | null = null,
  series?: RoomSeries,
): PlayerView => {
  const hand: readonly Card[] = authority?.state.hands.get(playerId) ?? [];
  return playerViewSchema.parse({
    audience: 'player',
    viewerPlayerId: playerId,
    public: projectPublicSnapshot(
      room,
      stateVersion,
      authority,
      turnDeadline,
      series,
    ),
    private: { hand, legalActionTypes: legalActions(authority, playerId) },
  });
};

export const projectSpectatorView = (
  room: RoomSnapshot,
  stateVersion: number,
  authority?: AuthorityState,
  turnDeadline: string | null = null,
  series?: RoomSeries,
): SpectatorView =>
  spectatorViewSchema.parse({
    audience: 'spectator',
    public: projectPublicSnapshot(
      room,
      stateVersion,
      authority,
      turnDeadline,
      series,
    ),
  });
