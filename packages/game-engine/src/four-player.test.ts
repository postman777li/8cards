import type { Card, CardId } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { createStandardDeck } from './cards.js';
import type { InitialDeal } from './deal.js';
import {
  applyFourPlayerAction,
  assertFourPlayerInvariant,
  createFourPlayerState,
  FourPlayerEngineError,
  type FourPlayerAction,
  type FourPlayerState,
} from './four-player.js';

const players = ['A', 'B', 'C', 'D'] as const;
type Player = (typeof players)[number];
const defaults: Record<Player, string[]> = {
  A: [
    'clubs-3',
    'spades-4',
    'hearts-5',
    'clubs-6',
    'spades-7',
    'hearts-9',
    'clubs-J',
    'spades-K',
  ],
  B: [
    'clubs-4',
    'diamonds-5',
    'diamonds-6',
    'diamonds-7',
    'diamonds-8',
    'diamonds-9',
    'diamonds-J',
    'diamonds-K',
  ],
  C: [
    'hearts-3',
    'hearts-4',
    'spades-5',
    'hearts-6',
    'clubs-7',
    'spades-9',
    'hearts-J',
    'clubs-K',
  ],
  D: [
    'spades-3',
    'clubs-5',
    'spades-6',
    'hearts-7',
    'clubs-8',
    'spades-10',
    'hearts-Q',
    'clubs-A',
  ],
};
function card(id: string): Card {
  return createStandardDeck().find((value) => value.id === id)!;
}
function deal(
  overrides: Partial<Record<Player, readonly string[]>> = {},
  firstDefender: Player = 'B',
): InitialDeal<Player> {
  const ids = Object.fromEntries(
    players.map((p) => [p, overrides[p] ?? defaults[p]]),
  ) as Record<Player, readonly string[]>;
  const hands = new Map(players.map((p) => [p, ids[p].map(card)]));
  const used = new Set(players.flatMap((p) => [...ids[p]]));
  const rest = createStandardDeck().filter((value) => !used.has(value.id));
  const index = rest.findIndex((value) => value.id === 'diamonds-3');
  const [indicator] = rest.splice(index, 1);
  return {
    hands,
    stock: [...rest, indicator!],
    indicator: indicator! as Card & { kind: 'standard' },
    trumpSuit: 'diamonds',
    firstDefender,
    indicatorOriginalIndex: 0,
    drawOrder: players,
  };
}
const initial = (source = deal()) => createFourPlayerState(source, players);
const act = (
  state: FourPlayerState<Player>,
  action: FourPlayerAction<Player>,
) => applyFourPlayerAction(state, action);
const attack = (state: FourPlayerState<Player>, id: string) =>
  act(state, { type: 'attack', playerId: state.actor!, cardId: id as CardId });
const defend = (state: FourPlayerState<Player>, id: string) =>
  act(state, {
    type: 'defend',
    playerId: state.defender,
    cardId: id as CardId,
  });
const pass = (state: FourPlayerState<Player>) =>
  act(state, { type: 'pass', playerId: state.actor! });
function expectCode(run: () => unknown, code: string) {
  expect(run).toThrowError(
    expect.objectContaining({ name: 'FourPlayerEngineError', code }),
  );
}

describe('four-player teams, initialization, and permissions', () => {
  it('groups opposite seats and maps all first defenders to roles', () => {
    const expected = {
      A: ['D', 'B', 'C'],
      B: ['A', 'C', 'D'],
      C: ['B', 'D', 'A'],
      D: ['C', 'A', 'B'],
    } as const;
    for (const defender of players) {
      const state = createFourPlayerState(deal({}, defender), players);
      const [roundAttacker, other, observer] = expected[defender];
      expect(state).toMatchObject({
        defender,
        roundAttacker,
        attackCursor: roundAttacker,
        actor: roundAttacker,
        attackers: [roundAttacker, other],
        observer,
      });
      expect(state.teams).toEqual([
        { id: 0, members: ['A', 'C'] },
        { id: 1, members: ['B', 'D'] },
      ]);
    }
  });

  it('rejects invalid seats, hands, indicators, and damaged decks', () => {
    expectCode(
      () => createFourPlayerState(deal(), ['A', 'B', 'C']),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createFourPlayerState(deal(), ['A', 'B', 'C', 'C']),
      'INVALID_INITIAL_STATE',
    );
    const base = deal();
    expectCode(
      () =>
        createFourPlayerState(
          { ...base, hands: new Map([['A', base.hands.get('A')!]]) },
          players,
        ),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () =>
        createFourPlayerState({ ...base, stock: base.stock.slice(1) }, players),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createFourPlayerState({ ...base, trumpSuit: 'clubs' }, players),
      'INVALID_INITIAL_STATE',
    );
  });

  it('allows only cursor attacker and defender while observer cannot act', () => {
    const state = initial();
    const snapshot = structuredClone(state);
    for (const action of [
      { type: 'attack', playerId: 'C', cardId: 'hearts-3' },
      { type: 'pass', playerId: 'D' },
      { type: 'defend', playerId: 'D', cardId: 'spades-3' },
      { type: 'take', playerId: 'D' },
    ] as const)
      expectCode(
        () => act(state, action),
        action.type === 'defend'
          ? 'WRONG_ACTOR'
          : action.type === 'take'
            ? 'WRONG_ACTOR'
            : 'WRONG_ACTOR',
      );
    expect(state).toEqual(snapshot);
  });
});

describe('dual attacker cursor, ranks, limits, and taking', () => {
  it('allows the team sixth attack under a six-card snapshot and rejects the seventh', () => {
    const ready = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    const sixth = attack(
      { ...ready, attackCount: 5, roundAttackLimit: 6 },
      'hearts-4',
    );
    expect(sixth.attackCount).toBe(6);
    expectCode(
      () =>
        attack({ ...ready, attackCount: 6, roundAttackLimit: 6 }, 'hearts-4'),
      'ATTACK_LIMIT_REACHED',
    );
  });
  it('alternates A and C after defenses and supports consecutive pass settlement', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    expect(state).toMatchObject({ actor: 'C', attackCursor: 'C' });
    state = defend(attack(state, 'hearts-4'), 'diamonds-5');
    expect(state).toMatchObject({ actor: 'A', attackCursor: 'A' });
    state = pass(pass(state));
    expect(state).toMatchObject({
      roundAttacker: 'B',
      defender: 'C',
      observer: 'A',
      attackers: ['B', 'D'],
      actor: 'B',
    });
  });

  it('resets passes after a legal attack so the earlier passer returns', () => {
    let state = pass(defend(attack(initial(), 'clubs-3'), 'clubs-4'));
    state = defend(attack(state, 'spades-4'), 'diamonds-5');
    expect(state).toMatchObject({ actor: 'C', consecutivePasses: 0 });
  });

  it('shares ranks and a fixed round count while rejecting illegal attacks and defenses', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    expect(state.leadRanks).toEqual(new Set(['3', '4']));
    expectCode(() => attack(state, 'spades-5'), 'RANK_NOT_ON_TABLE');
    state = defend(attack(state, 'hearts-4'), 'diamonds-5');
    state = defend(attack(state, 'spades-4'), 'diamonds-6');
    state = defend(attack(state, 'hearts-3'), 'diamonds-7');
    expect(state.attackCount).toBe(4);
    state = attack(state, 'hearts-5');
    expect(state.attackCount).toBe(5);
    const jokerState = createFourPlayerState(
      deal({ A: ['big-joker', ...defaults.A.slice(1)] }),
      players,
    );
    expectCode(() => attack(jokerState, 'big-joker'), 'JOKER_CANNOT_ATTACK');
    expectCode(
      () => defend(attack(initial(), 'clubs-3'), 'diamonds-3'),
      'CARD_NOT_IN_HAND',
    );
  });

  it('does not add joker defense rank', () => {
    const state = defend(
      attack(
        createFourPlayerState(
          deal({ B: ['small-joker', ...defaults.B.slice(1)] }),
          players,
        ),
        'clubs-3',
      ),
      'small-joker',
    );
    expect(state.leadRanks).toEqual(new Set(['3']));
  });

  it.each([0, 1, 2])(
    'allows defender to take after %s defenses and skips B',
    (count) => {
      let state = attack(initial(), 'clubs-3');
      if (count >= 1) state = attack(defend(state, 'clubs-4'), 'hearts-4');
      if (count >= 2) state = attack(defend(state, 'diamonds-5'), 'spades-4');
      state = act(state, { type: 'take', playerId: 'B' });
      expect(state).toMatchObject({
        roundAttacker: 'C',
        defender: 'D',
        observer: 'B',
        attackers: ['C', 'A'],
        actor: 'C',
        table: [],
      });
      assertFourPlayerInvariant(state);
    },
  );
});

describe('replenishment, complete flow, exchange, and terminal teams', () => {
  it.each(['defended', 'taken'] as const)(
    'replenishes %s in A/B/C/D order with a short stock',
    (kind) => {
      let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
      const cMoved = state.hands.get('C')!.at(-1)!;
      const dMoved = state.hands.get('D')!.at(-1)!;
      state = {
        ...state,
        hands: new Map(state.hands)
          .set('C', state.hands.get('C')!.slice(0, -1))
          .set('D', state.hands.get('D')!.slice(0, -1)),
        discard: [...state.discard, cMoved, dMoved],
      };
      const top = state.stock.slice(0, 4).map((value) => value.id);
      const short = state.stock.slice(0, 4);
      state = {
        ...state,
        stock: short,
        bottomCard: short.at(-1)!,
        discard: [...state.discard, ...state.stock.slice(4)],
      };
      state =
        kind === 'defended'
          ? pass(pass(state))
          : act(state, { type: 'take', playerId: 'B' });
      expect(state.hands.get('A')!.some((value) => value.id === top[0])).toBe(
        true,
      );
      if (kind === 'defended') {
        expect(state.hands.get('B')!.some((value) => value.id === top[1])).toBe(
          true,
        );
        expect(state.hands.get('C')!.some((value) => value.id === top[2])).toBe(
          true,
        );
        expect(state.hands.get('D')!.some((value) => value.id === top[3])).toBe(
          true,
        );
      } else {
        expect(state.hands.get('C')!.some((value) => value.id === top[1])).toBe(
          true,
        );
        expect(state.hands.get('D')!.some((value) => value.id === top[2])).toBe(
          true,
        );
      }
      assertFourPlayerInvariant(state);
    },
  );

  it('runs A attack, C follow, passes, A/B/C/D refill, and next roles', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    state = pass(state);
    state = defend(attack(state, 'spades-4'), 'diamonds-5');
    state = pass(pass(state));
    expect(state).toMatchObject({
      roundAttacker: 'B',
      defender: 'C',
      observer: 'A',
      attackers: ['B', 'D'],
      actor: 'B',
      table: [],
    });
    expect(state.discard).toHaveLength(4);
    assertFourPlayerInvariant(state);
  });

  it.each(players)(
    'allows %s in any role to exchange trump two without moving cursor',
    (holder) => {
      const state = createFourPlayerState(
        deal({ [holder]: ['diamonds-2', ...defaults[holder].slice(1)] }),
        players,
      );
      const next = act(state, { type: 'exchange-trump-two', playerId: holder });
      expect(next).toMatchObject({
        actor: state.actor,
        attackCursor: state.attackCursor,
        defender: state.defender,
        observer: state.observer,
        bottomCard: card('diamonds-2'),
      });
      expectCode(
        () => act(next, { type: 'exchange-trump-two', playerId: holder }),
        'INDICATOR_ALREADY_EXCHANGED',
      );
    },
  );

  it.each(players)('awards %s team when that player empties hand', (winner) => {
    const defender = players[(players.indexOf(winner) + 1) % 4]!;
    let state = createFourPlayerState(deal({}, defender), players);
    const keep = { A: 'clubs-3', B: 'clubs-4', C: 'hearts-3', D: 'spades-3' }[
      winner
    ];
    const moved = state.hands.get(winner)!.filter((value) => value.id !== keep);
    state = {
      ...state,
      hands: new Map(state.hands).set(winner, [card(keep)]),
      discard: [...state.discard, ...moved],
    };
    const result = attack(state, keep);
    expect(result.phase).toBe('finished');
    expect(result.result).toMatchObject({
      triggerPlayer: winner,
      reason: 'emptied-hand',
      winningTeam: {
        members: winner === 'A' || winner === 'C' ? ['A', 'C'] : ['B', 'D'],
      },
    });
  });

  it.each(players)('makes %s whole team lose for joker-only hand', (loser) => {
    let state = createFourPlayerState(
      deal({
        [loser]: ['small-joker', 'big-joker', ...defaults[loser].slice(2)],
      }),
      players,
    );
    const hand = state.hands.get(loser)!;
    const moved = hand.filter((value) => value.kind !== 'joker');
    state = {
      ...state,
      hands: new Map(state.hands).set(
        loser,
        hand.filter((value) => value.kind === 'joker'),
      ),
      discard: [...state.discard, ...moved],
    };
    const actor = loser === 'A' ? 'C' : 'A';
    const opening = actor === 'C' ? 'hearts-3' : 'clubs-3';
    const result = attack({ ...state, actor, attackCursor: actor }, opening);
    expect(result.result).toMatchObject({
      triggerPlayer: loser,
      reason: 'stuck-with-jokers',
      losingTeam: {
        members: loser === 'A' || loser === 'C' ? ['A', 'C'] : ['B', 'D'],
      },
    });
    expectCode(
      () => act(result, { type: 'pass', playerId: 'A' }),
      'GAME_FINISHED',
    );
  });

  it('keeps 54 cards and exposes stable error class', () => {
    let state = initial();
    for (const action of [
      { type: 'attack', playerId: 'A', cardId: 'clubs-3' },
      { type: 'defend', playerId: 'B', cardId: 'clubs-4' },
      { type: 'pass', playerId: 'C' },
      { type: 'pass', playerId: 'A' },
    ] as FourPlayerAction<Player>[]) {
      state = act(state, action);
      assertFourPlayerInvariant(state);
    }
    expect(state.version).toBe(4);
    expect(() => attack(initial(), 'big-joker')).toThrow(FourPlayerEngineError);
  });
});
