import {
  playerViewSchema,
  publicSnapshotSchema,
  type Card,
  type GamePublicState,
  type GameId,
  type PlayerId,
  type PlayerView,
  type PublicSnapshot,
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
  roomId: string,
): GamePublicState => {
  const { state } = authority;
  const winners = winnerIds(authority);
  const attackPlayerId =
    authority.mode === 2
      ? authority.state.attacker
      : authority.state.roundAttacker;
  return {
    gameId: `game-${roomId}` as GameId,
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
    players: state.players.map((playerId) => ({
      playerId,
      handCount: state.hands.get(playerId)?.length ?? 0,
      ...roles(authority, playerId),
    })),
    currentActorId: state.actor,
    attackerId:
      authority.mode === 2
        ? (state as TwoPlayerState<PlayerId>).attacker
        : (state as ThreePlayerState<PlayerId> | FourPlayerState<PlayerId>)
            .roundAttacker,
    defenderId: state.defender,
    turnDeadline: null,
    ...(winners ? { winnerPlayerIds: winners } : {}),
  };
};

export const projectPublicSnapshot = (
  room: RoomSnapshot,
  stateVersion: number,
  authority?: AuthorityState,
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
    },
    game: authority ? projectGame(authority, room.roomId) : null,
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
      result.push('pass');
    }
  }
  return result;
};

export const projectPlayerView = (
  room: RoomSnapshot,
  stateVersion: number,
  playerId: PlayerId,
  authority?: AuthorityState,
): PlayerView => {
  const hand: readonly Card[] = authority?.state.hands.get(playerId) ?? [];
  return playerViewSchema.parse({
    audience: 'player',
    viewerPlayerId: playerId,
    public: projectPublicSnapshot(room, stateVersion, authority),
    private: { hand, legalActionTypes: legalActions(authority, playerId) },
  });
};
