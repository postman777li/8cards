import type { Card, CardId } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { createStandardDeck } from './cards.js';
import type { InitialDeal } from './deal.js';
import {
  applyThreePlayerAction,
  assertThreePlayerInvariant,
  createThreePlayerState,
  ThreePlayerEngineError,
  type ThreePlayerAction,
  type ThreePlayerState,
} from './three-player.js';

const players = ['A', 'B', 'C'] as const;
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
};

function card(id: string): Card {
  return createStandardDeck().find((candidate) => candidate.id === id)!;
}

function deal(
  overrides: Partial<Record<Player, readonly string[]>> = {},
  firstDefender: Player = 'B',
): InitialDeal<Player> {
  const ids = Object.fromEntries(
    players.map((player) => [player, overrides[player] ?? defaults[player]]),
  ) as Record<Player, readonly string[]>;
  const hands = new Map(
    players.map((player) => [player, ids[player].map(card)]),
  );
  const used = new Set(players.flatMap((player) => [...ids[player]]));
  const rest = createStandardDeck().filter((value) => !used.has(value.id));
  const indicatorIndex = rest.findIndex((value) => value.id === 'diamonds-3');
  const [indicator] = rest.splice(indicatorIndex, 1);
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

const initial = (source = deal()) => createThreePlayerState(source, players);
function act(
  state: ThreePlayerState<Player>,
  action: ThreePlayerAction<Player>,
) {
  return applyThreePlayerAction(state, action);
}
function attack(state: ThreePlayerState<Player>, id: string) {
  return act(state, {
    type: 'attack',
    playerId: state.actor!,
    cardId: id as CardId,
  });
}
function defend(state: ThreePlayerState<Player>, id: string) {
  return act(state, {
    type: 'defend',
    playerId: state.defender,
    cardId: id as CardId,
  });
}
function pass(state: ThreePlayerState<Player>) {
  return act(state, { type: 'pass', playerId: state.actor! });
}
function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(
    expect.objectContaining({ name: 'ThreePlayerEngineError', code }),
  );
}

describe('three-player initialization and cursor', () => {
  it.each([
    ['A', 'C'],
    ['B', 'A'],
    ['C', 'B'],
  ] as const)(
    'uses the seat before defender %s as round attacker %s',
    (defender, attacker) => {
      expect(createThreePlayerState(deal({}, defender), players)).toMatchObject(
        {
          defender,
          roundAttacker: attacker,
          attackCursor: attacker,
          actor: attacker,
        },
      );
    },
  );

  it('rejects wrong seats, duplicate seats, missing hands, and damaged decks', () => {
    expectCode(
      () => createThreePlayerState(deal(), ['A', 'B']),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createThreePlayerState(deal(), ['A', 'A', 'C']),
      'INVALID_INITIAL_STATE',
    );
    const base = deal();
    expectCode(
      () =>
        createThreePlayerState(
          { ...base, hands: new Map([['A', base.hands.get('A')!]]) },
          players,
        ),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () =>
        createThreePlayerState(
          { ...base, stock: base.stock.slice(1) },
          players,
        ),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createThreePlayerState({ ...base, trumpSuit: 'clubs' }, players),
      'INVALID_INITIAL_STATE',
    );
  });

  it('moves A to C after defense and C back to A after defense', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    expect(state).toMatchObject({ actor: 'C', attackCursor: 'C' });
    state = defend(attack(state, 'hearts-3'), 'diamonds-5');
    expect(state).toMatchObject({ actor: 'A', attackCursor: 'A' });
    expect(state.actor).not.toBe(state.defender);
  });

  it('rejects wrong actors and phases without mutating input', () => {
    const state = initial();
    const snapshot = structuredClone(state);
    expectCode(
      () => act(state, { type: 'attack', playerId: 'C', cardId: 'hearts-3' }),
      'WRONG_ACTOR',
    );
    expectCode(
      () => act(state, { type: 'defend', playerId: 'A', cardId: 'clubs-3' }),
      'WRONG_PHASE',
    );
    expect(state).toEqual(snapshot);
  });
});

describe('passes, attacks, and defenses', () => {
  it('settles only after A and C pass consecutively', () => {
    const opened = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    const once = pass(opened);
    expect(once).toMatchObject({
      actor: 'A',
      consecutivePasses: 1,
      version: 3,
    });
    const done = pass(once);
    expect(done).toMatchObject({
      roundAttacker: 'B',
      defender: 'C',
      actor: 'B',
      consecutivePasses: 0,
      version: 4,
    });
  });

  it('allows passing with or without legal cards and resets passes after a new attack', () => {
    let state = pass(defend(attack(initial(), 'clubs-3'), 'clubs-4'));
    state = defend(attack(state, 'spades-4'), 'diamonds-5');
    expect(state).toMatchObject({ actor: 'C', consecutivePasses: 0 });
    state = defend(attack(state, 'hearts-4'), 'diamonds-6');
    expect(state.actor).toBe('A');
  });

  it('allows both attackers to follow table ranks and defense standard cards add ranks', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    expect(state.leadRanks).toEqual(new Set(['3', '4']));
    state = defend(attack(state, 'hearts-4'), 'diamonds-5');
    state = attack(state, 'spades-4');
    expect(state.table.at(-1)?.attack.id).toBe('spades-4');
  });

  it('rejects unseen ranks, joker attacks, absent cards, and illegal defenses', () => {
    const state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    expectCode(() => attack(state, 'spades-5'), 'RANK_NOT_ON_TABLE');
    const jokerSource = deal({ C: ['big-joker', ...defaults.C.slice(1)] });
    const jokerTurn = defend(
      attack(createThreePlayerState(jokerSource, players), 'clubs-3'),
      'clubs-4',
    );
    expectCode(() => attack(jokerTurn, 'big-joker'), 'JOKER_CANNOT_ATTACK');
    expectCode(() => attack(state, 'clubs-10'), 'CARD_NOT_IN_HAND');
    expectCode(
      () => defend(attack(initial(), 'clubs-3'), 'diamonds-2'),
      'CARD_NOT_IN_HAND',
    );
    expectCode(
      () => defend(attack(initial(), 'clubs-3'), 'diamonds-3'),
      'CARD_NOT_IN_HAND',
    );
  });

  it('does not add a rank when defense uses a joker', () => {
    const source = deal({ B: ['small-joker', ...defaults.B.slice(1)] });
    const state = defend(
      attack(createThreePlayerState(source, players), 'clubs-3'),
      'small-joker',
    );
    expect(state.leadRanks).toEqual(new Set(['3']));
  });
});

describe('taking, limits, replenishment, and next rounds', () => {
  it('allows the shared sixth attack under a six-card snapshot and rejects the seventh', () => {
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
  it.each([0, 1, 2])(
    'lets the defender take after %s completed defenses',
    (defenses) => {
      let state = attack(initial(), 'clubs-3');
      if (defenses >= 1) state = attack(defend(state, 'clubs-4'), 'hearts-3');
      if (defenses >= 2)
        state = attack(defend(state, 'diamonds-5'), 'spades-4');
      const result = act(state, { type: 'take', playerId: 'B' });
      expect(result).toMatchObject({
        roundAttacker: 'C',
        defender: 'A',
        actor: 'C',
      });
      expect(result.table).toHaveLength(0);
      assertThreePlayerInvariant(result);
    },
  );

  it('rejects taking by attackers or from an empty table', () => {
    expectCode(
      () => act(attack(initial(), 'clubs-3'), { type: 'take', playerId: 'A' }),
      'WRONG_ACTOR',
    );
    expectCode(
      () => act(initial(), { type: 'take', playerId: 'B' }),
      'WRONG_PHASE',
    );
  });

  it('shares the fixed opening attack limit across both attackers', () => {
    let state = initial();
    for (const [a, d] of [
      ['clubs-3', 'clubs-4'],
      ['hearts-3', 'diamonds-5'],
      ['spades-4', 'diamonds-6'],
      ['hearts-4', 'diamonds-7'],
    ] as const)
      state = defend(attack(state, a), d);
    expect(state).toMatchObject({ attackCount: 4, actor: 'A' });
    state = attack(state, 'hearts-5');
    expect(state.attackCount).toBe(5);
  });

  it('replenishes in A, B, C order on defense and take, skipping full hands', () => {
    for (const kind of ['defended', 'taken'] as const) {
      let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
      const top = state.stock.slice(0, 3).map((value) => value.id);
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
          false,
        );
      } else {
        expect(state.hands.get('C')!.some((value) => value.id === top[1])).toBe(
          false,
        );
      }
    }
  });

  it('exhausts a short stock in full seat order', () => {
    const attacked = attack(initial(), 'clubs-3');
    const short = attacked.stock.slice(0, 1);
    const custom = {
      ...attacked,
      stock: short,
      bottomCard: short[0]!,
      discard: [...attacked.discard, ...attacked.stock.slice(1)],
    };
    const result = act(custom, { type: 'take', playerId: 'B' });
    expect(result.stock).toHaveLength(0);
    expect(result.hands.get('A')).toHaveLength(8);
    assertThreePlayerInvariant(result);
  });

  it('completes a multi-attacker flow through passes, replenishment, and role rotation', () => {
    let state = initial();
    state = defend(attack(state, 'clubs-3'), 'clubs-4');
    state = pass(state);
    state = defend(attack(state, 'spades-4'), 'diamonds-5');
    state = pass(state);
    state = pass(state);
    expect(state).toMatchObject({
      roundAttacker: 'B',
      defender: 'C',
      actor: 'B',
      table: [],
      consecutivePasses: 0,
    });
    expect(state.discard).toHaveLength(4);
    assertThreePlayerInvariant(state);
  });
});

describe('exchange, terminal results, and invariants', () => {
  it.each(['A', 'B', 'C'] as const)(
    'allows role %s to exchange without changing the cursor',
    (holder) => {
      const source = deal({
        [holder]: ['diamonds-2', ...defaults[holder].slice(1)],
      });
      const state = initial(source);
      const next = act(state, { type: 'exchange-trump-two', playerId: holder });
      expect(next).toMatchObject({
        actor: state.actor,
        attackCursor: state.attackCursor,
        defender: state.defender,
        roundAttacker: state.roundAttacker,
        consecutivePasses: 0,
        bottomCard: card('diamonds-2'),
      });
      expectCode(
        () => act(next, { type: 'exchange-trump-two', playerId: holder }),
        'INDICATOR_ALREADY_EXCHANGED',
      );
    },
  );

  it.each(['A', 'B', 'C'] as const)(
    'records independent empty-hand winner %s',
    (winner) => {
      let state = initial();
      const keep =
        winner === 'A' ? 'clubs-3' : winner === 'B' ? 'clubs-4' : 'hearts-3';
      const moved = state.hands
        .get(winner)!
        .filter((value) => value.id !== keep);
      state = {
        ...state,
        hands: new Map(state.hands).set(winner, [card(keep)]),
        discard: [...state.discard, ...moved],
      };
      const result =
        winner === 'A'
          ? attack(state, keep)
          : winner === 'B'
            ? defend(attack(state, 'clubs-3'), keep)
            : attack({ ...state, actor: 'C', attackCursor: 'C' }, keep);
      expect(result).toMatchObject({
        phase: 'finished',
        result: { outcome: 'winner', winner, reason: 'emptied-hand' },
      });
    },
  );

  it.each(['A', 'B', 'C'] as const)(
    'records independent joker-only loser %s',
    (loser) => {
      const source = deal({
        [loser]: ['small-joker', 'big-joker', ...defaults[loser].slice(2)],
      });
      let state = initial(source);
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
      expect(result).toMatchObject({
        phase: 'finished',
        result: { outcome: 'loser', loser, reason: 'stuck-with-jokers' },
      });
      expectCode(
        () => act(result, { type: 'pass', playerId: 'A' }),
        'GAME_FINISHED',
      );
    },
  );

  it('keeps all 54 unique cards after every successful action', () => {
    let state = initial();
    const actions: ThreePlayerAction<Player>[] = [
      { type: 'attack', playerId: 'A', cardId: 'clubs-3' },
      { type: 'defend', playerId: 'B', cardId: 'clubs-4' },
      { type: 'pass', playerId: 'C' },
      { type: 'pass', playerId: 'A' },
    ];
    for (const action of actions) {
      state = act(state, action);
      assertThreePlayerInvariant(state);
    }
    expect(state.version).toBe(4);
  });

  it('exports the stable error class', () => {
    try {
      attack(initial(), 'big-joker');
    } catch (error) {
      expect(error).toBeInstanceOf(ThreePlayerEngineError);
    }
  });
});
