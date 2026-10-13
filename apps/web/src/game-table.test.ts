import {
  playerViewSchema,
  type Card,
  type GamePublicState,
} from '@8cards/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  pairTable,
  GameTable,
  playerRoleLabel,
  relativeSeatMap,
  resultCopy,
  secondsRemaining,
  sortHand,
} from './game-table.js';

const card = (id: string): Card => {
  if (id === 'small-joker' || id === 'big-joker')
    return { id, kind: 'joker', rank: id } as Card;
  const [suit, rank] = id.split('-');
  return { id, kind: 'standard', suit, rank } as Card;
};

describe('game table authority mapping', () => {
  it.each([
    [3, ['self', 'right', 'left']],
    [4, ['self', 'right', 'top', 'left']],
  ] as const)(
    'rotates %i stable seats around every possible viewer',
    (count, expected) => {
      const seats = Array.from({ length: count }, (_, seat) => ({
        playerId: `p${seat}`,
        seat,
      }));
      for (let viewer = 0; viewer < count; viewer += 1) {
        const positions = relativeSeatMap(seats, `p${viewer}`);
        expect(
          Array.from({ length: count }, (_, offset) =>
            positions.get(`p${(viewer + offset) % count}`),
          ),
        ).toEqual(expected);
      }
    },
  );

  it('sorts a display copy without changing card ids or the server hand', () => {
    const hand = [card('big-joker'), card('hearts-A'), card('clubs-3')];
    expect(sortHand(hand).map((item) => item.id)).toEqual([
      'clubs-3',
      'hearts-A',
      'big-joker',
    ]);
    expect(hand.map((item) => item.id)).toEqual([
      'big-joker',
      'hearts-A',
      'clubs-3',
    ]);
  });

  it('pairs public attack and defense purposes and retains an uncovered attack', () => {
    const table = [
      { playerId: 'p1', card: card('clubs-3'), purpose: 'attack' },
      { playerId: 'p2', card: card('clubs-4'), purpose: 'defense' },
      { playerId: 'p1', card: card('hearts-4'), purpose: 'attack' },
    ] as GamePublicState['table'];
    const pairs = pairTable(table);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.defense?.card.id).toBe('clubs-4');
    expect(pairs[1]?.attack.card.id).toBe('hearts-4');
    expect(pairs[1]?.defense).toBeUndefined();
  });

  it('uses the authoritative deadline and never goes below zero', () => {
    const deadline = '2026-10-13T12:00:20.000Z';
    expect(
      secondsRemaining(deadline, Date.parse('2026-10-13T12:00:14.100Z')),
    ).toBe(6);
    expect(
      secondsRemaining(deadline, Date.parse('2026-10-13T12:00:21.000Z')),
    ).toBe(0);
    expect(secondsRemaining(null, Date.now())).toBeNull();
  });

  it('labels public four-player teams and round roles without inferring them from seats', () => {
    const game = {
      attackerId: 'p3',
      players: [
        { playerId: 'p0', role: 'observer', team: 'team-b' },
        { playerId: 'p1', role: 'attacker', team: 'team-a' },
        { playerId: 'p2', role: 'defender', team: 'team-b' },
        { playerId: 'p3', role: 'attacker', team: 'team-a' },
      ],
    } as GamePublicState;
    expect(playerRoleLabel(game.players[0]!, game, 'team-b')).toBe(
      '队友 · 旁观本轮 · 不能跟牌',
    );
    expect(playerRoleLabel(game.players[3]!, game, 'team-b')).toBe(
      '对手 · 本轮主攻',
    );
  });

  it('describes independent and team joker losses from public result ids', () => {
    const solo = {
      resultReason: 'stuck-with-jokers',
      loserPlayerIds: ['p1'],
      players: [{ playerId: 'p1', role: 'attacker', team: 'solo' }],
    } as GamePublicState;
    expect(resultCopy(solo, solo.players[0]!.playerId).title).toBe(
      '你因憋王落败',
    );
    const duel = {
      resultReason: 'stuck-with-jokers',
      winnerPlayerIds: ['p0'],
      players: [
        { playerId: 'p0', role: 'attacker', team: 'solo' },
        { playerId: 'p1', role: 'defender', team: 'solo' },
      ],
    } as GamePublicState;
    expect(resultCopy(duel, duel.players[1]!.playerId).detail).toBe(
      '本局因你触发憋王结束。',
    );
    const team = {
      resultReason: 'stuck-with-jokers',
      winnerPlayerIds: ['p0', 'p2'],
      loserPlayerIds: ['p1', 'p3'],
      players: [
        { playerId: 'p0', role: 'attacker', team: 'team-a' },
        { playerId: 'p1', role: 'defender', team: 'team-b' },
        { playerId: 'p3', role: 'attacker', team: 'team-b' },
      ],
    } as GamePublicState;
    expect(resultCopy(team, team.players[2]!.playerId)).toEqual({
      title: '你所在的队伍落败',
      detail: '本局因本队憋王结束。',
    });
    expect(resultCopy(team, team.players[0]!.playerId)).toEqual({
      title: '你所在的队伍获胜',
      detail: '本局因对方队伍憋王结束。',
    });
  });

  it('renders a shared four-player table with public roles and only the viewer hand', () => {
    const players = ['p0', 'p1', 'p2', 'p3'].map((playerId, seat) => ({
      identity: 'player' as const,
      playerId,
      nickname: `玩家${seat}`,
      seat,
      isHost: seat === 0,
      connection: 'online' as const,
      readiness: 'ready' as const,
    }));
    const view = playerViewSchema.parse({
      audience: 'player',
      viewerPlayerId: 'p1',
      public: {
        stateVersion: 8,
        room: {
          roomId: 'room-1',
          name: '四人好友桌',
          code: 'ABC123',
          config: {
            playerCount: 4,
            allowSpectators: true,
            allowChat: true,
            turnTimeoutSeconds: 20,
          },
          players,
          spectators: [],
        },
        game: {
          gameId: 'game-1',
          phase: 'attacking',
          trumpSuit: 'hearts',
          exposedCard: card('hearts-7'),
          stockCount: 21,
          table: [
            {
              playerId: 'p3',
              card: card('clubs-3'),
              purpose: 'attack',
            },
            {
              playerId: 'p0',
              card: card('clubs-4'),
              purpose: 'defense',
            },
          ],
          players: [
            { playerId: 'p0', handCount: 7, role: 'defender', team: 'team-a' },
            { playerId: 'p1', handCount: 8, role: 'attacker', team: 'team-b' },
            { playerId: 'p2', handCount: 8, role: 'observer', team: 'team-a' },
            { playerId: 'p3', handCount: 7, role: 'attacker', team: 'team-b' },
          ],
          currentActorId: 'p1',
          attackerId: 'p3',
          defenderId: 'p0',
          turnDeadline: '2026-10-13T12:00:20.000Z',
        },
      },
      private: {
        hand: [card('diamonds-A')],
        legalActionTypes: ['play-card', 'pass'],
      },
    });
    const markup = renderToStaticMarkup(
      createElement(GameTable, {
        view,
        connection: undefined,
        connectionState: 'started',
        onSafeReturn: () => undefined,
      }),
    );
    expect(markup).toContain('4人游戏牌桌');
    expect(markup).toContain('旁观本轮 · 不能跟牌');
    expect(markup).toContain('队友 · 本轮主攻');
    expect(markup).toContain('玩家3·攻');
    expect(markup).toContain('A');
    expect(markup).not.toContain('对手手牌');
  });
});
