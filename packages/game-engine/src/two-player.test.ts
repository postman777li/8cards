import type { Card, CardId } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { createStandardDeck } from './cards.js';
import type { InitialDeal } from './deal.js';
import {
  applyTwoPlayerAction,
  assertTwoPlayerInvariant,
  createTwoPlayerState,
  TwoPlayerEngineError,
  type TwoPlayerAction,
  type TwoPlayerState,
} from './two-player.js';

const players = ['alice', 'bob'] as const;

function card(id: string): Card {
  return createStandardDeck().find((candidate) => candidate.id === id)!;
}

function deal(
  aliceIds = [
    'clubs-3',
    'clubs-5',
    'hearts-7',
    'spades-9',
    'diamonds-J',
    'clubs-K',
    'hearts-A',
    'spades-2',
  ],
  bobIds = [
    'clubs-4',
    'clubs-6',
    'hearts-8',
    'spades-10',
    'diamonds-Q',
    'clubs-A',
    'hearts-2',
    'small-joker',
  ],
  firstDefender: (typeof players)[number] = 'bob',
): InitialDeal<(typeof players)[number]> {
  const hands = new Map([
    ['alice' as const, aliceIds.map(card)],
    ['bob' as const, bobIds.map(card)],
  ]);
  const used = new Set([...aliceIds, ...bobIds]);
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

const initial = (source = deal()) => createTwoPlayerState(source, players);
const attack = (state: TwoPlayerState<(typeof players)[number]>, id: string) =>
  applyTwoPlayerAction(state, {
    type: 'attack',
    playerId: state.attacker,
    cardId: id as CardId,
  });
const defend = (state: TwoPlayerState<(typeof players)[number]>, id: string) =>
  applyTwoPlayerAction(state, {
    type: 'defend',
    playerId: state.defender,
    cardId: id as CardId,
  });

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(
    expect.objectContaining({ name: 'TwoPlayerEngineError', code }),
  );
}

describe('two-player initialization', () => {
  it('maps the first defender and opposite first attacker', () => {
    const state = initial();
    expect(state).toMatchObject({
      phase: 'awaiting-attack',
      attacker: 'alice',
      defender: 'bob',
      actor: 'alice',
      version: 0,
    });
    assertTwoPlayerInvariant(state);
  });

  it('rejects non-two-player and duplicate player lists', () => {
    expectCode(
      () => createTwoPlayerState(deal(), ['alice'] as const),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createTwoPlayerState(deal(), ['alice', 'alice'] as const),
      'INVALID_INITIAL_STATE',
    );
  });

  it('rejects damaged cards, hands, and inconsistent indicator state', () => {
    const base = deal();
    expectCode(
      () =>
        createTwoPlayerState({ ...base, stock: base.stock.slice(1) }, players),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () =>
        createTwoPlayerState(
          {
            ...base,
            hands: new Map([
              ['alice', base.hands.get('alice')!],
              ['bob', []],
            ]),
          },
          players,
        ),
      'INVALID_INITIAL_STATE',
    );
    expectCode(
      () => createTwoPlayerState({ ...base, trumpSuit: 'clubs' }, players),
      'INVALID_INITIAL_STATE',
    );
  });
});

describe('attacks and defenses', () => {
  it('accepts a normal lead and rejects a joker lead', () => {
    expect(attack(initial(), 'clubs-3')).toMatchObject({
      phase: 'awaiting-defense',
      actor: 'bob',
      attackCount: 1,
    });
    const jokerLead = initial(
      deal([
        'big-joker',
        'clubs-3',
        'hearts-7',
        'spades-9',
        'diamonds-J',
        'clubs-K',
        'hearts-A',
        'spades-2',
      ]),
    );
    expectCode(() => attack(jokerLead, 'big-joker'), 'JOKER_CANNOT_ATTACK');
  });

  it('uses ranks contributed by both attack and defense standard cards', () => {
    let state = defend(
      attack(
        initial(
          deal([
            'clubs-3',
            'spades-4',
            'hearts-7',
            'spades-9',
            'diamonds-J',
            'clubs-K',
            'hearts-A',
            'spades-2',
          ]),
        ),
        'clubs-3',
      ),
      'clubs-4',
    );
    expect(state.leadRanks).toEqual(new Set(['3', '4']));
    state = attack(state, 'spades-4');
    expect(state.table.at(-1)?.attack.id).toBe('spades-4');
  });

  it('rejects unseen ranks, absent cards, wrong actors, and wrong phases without mutation', () => {
    const state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    const snapshot = structuredClone(state);
    expectCode(() => attack(state, 'hearts-7'), 'RANK_NOT_ON_TABLE');
    expectCode(() => attack(state, 'clubs-10'), 'CARD_NOT_IN_HAND');
    expectCode(
      () => applyTwoPlayerAction(state, { type: 'pass', playerId: 'bob' }),
      'WRONG_ACTOR',
    );
    const waitingDefense = attack(initial(), 'clubs-3');
    expectCode(
      () =>
        applyTwoPlayerAction(waitingDefense, {
          type: 'attack',
          playerId: 'bob',
          cardId: 'clubs-4',
        }),
      'WRONG_PHASE',
    );
    expect(state).toEqual(snapshot);
  });

  it.each([
    ['same-suit higher', 'clubs-3', 'clubs-4'],
    ['trump over side suit', 'clubs-3', 'diamonds-Q'],
    ['higher trump', 'diamonds-J', 'diamonds-Q'],
    ['joker over normal', 'clubs-3', 'small-joker'],
  ])('accepts %s defense', (_name, attackId, defenseId) => {
    expect(defend(attack(initial(), attackId), defenseId)).toMatchObject({
      phase: 'awaiting-attack',
      actor: 'alice',
    });
  });

  it.each([
    ['smaller', 'clubs-5', 'clubs-4'],
    ['cross-suit side card', 'clubs-3', 'hearts-8'],
    ['normal over trump', 'diamonds-J', 'clubs-A'],
  ])('rejects %s defense', (_name, attackId, defenseId) => {
    expectCode(
      () => defend(attack(initial(), attackId), defenseId),
      'CARD_CANNOT_BEAT_ATTACK',
    );
  });

  it('rejects an equal-rank card', () => {
    const source = deal(undefined, [
      'hearts-3',
      'clubs-6',
      'hearts-8',
      'spades-10',
      'diamonds-Q',
      'clubs-A',
      'hearts-2',
      'small-joker',
    ]);
    expectCode(
      () => defend(attack(initial(source), 'clubs-3'), 'hearts-3'),
      'CARD_CANNOT_BEAT_ATTACK',
    );
  });

  it('rejects normal cards and jokers as a higher response to a joker', () => {
    const state = initial();
    const attackCard = card('big-joker');
    const custom = {
      ...state,
      phase: 'awaiting-defense' as const,
      actor: 'bob' as const,
      table: [{ attack: attackCard }],
      leadRanks: new Set(),
      attackCount: 1,
    };
    // Keep conservation by moving the joker from stock onto the table.
    const valid = {
      ...custom,
      stock: custom.stock.filter((value) => value.id !== attackCard.id),
      bottomCard:
        custom.stock.filter((value) => value.id !== attackCard.id).at(-1) ??
        null,
    };
    expectCode(() => defend(valid, 'clubs-A'), 'CARD_CANNOT_BEAT_ATTACK');
    expectCode(() => defend(valid, 'small-joker'), 'CARD_CANNOT_BEAT_ATTACK');
  });
});

describe('round settlement and limits', () => {
  it('allows passing with a legal attack and swaps roles after attacker-first replenishment', () => {
    let state = defend(attack(initial(), 'clubs-3'), 'clubs-4');
    const top = state.stock.slice(0, 2).map((value) => value.id);
    state = applyTwoPlayerAction(state, { type: 'pass', playerId: 'alice' });
    expect(state).toMatchObject({
      phase: 'awaiting-attack',
      attacker: 'bob',
      defender: 'alice',
      actor: 'bob',
      attackCount: 0,
    });
    expect(state.hands.get('alice')!.some((value) => value.id === top[0])).toBe(
      true,
    );
    expect(state.hands.get('bob')!.some((value) => value.id === top[1])).toBe(
      true,
    );
    expect(state.discard).toHaveLength(2);
    expect(state.table).toHaveLength(0);
  });

  it('allows taking despite a legal defense and keeps roles', () => {
    const attacked = attack(initial(), 'clubs-3');
    const stockTop = attacked.stock[0]!.id;
    const state = applyTwoPlayerAction(attacked, {
      type: 'take',
      playerId: 'bob',
    });
    expect(state).toMatchObject({
      attacker: 'alice',
      defender: 'bob',
      actor: 'alice',
    });
    expect(
      state.hands.get('alice')!.some((value) => value.id === stockTop),
    ).toBe(true);
    expect(state.hands.get('bob')).toHaveLength(9);
    expect(state.discard).toHaveLength(0);
  });

  it('enforces the live 8-card limit at four successful defenses', () => {
    const source = deal(
      [
        'clubs-3',
        'spades-4',
        'hearts-5',
        'clubs-6',
        'spades-7',
        'hearts-9',
        'clubs-J',
        'spades-K',
      ],
      [
        'clubs-4',
        'diamonds-5',
        'diamonds-6',
        'diamonds-7',
        'diamonds-8',
        'diamonds-9',
        'diamonds-J',
        'diamonds-K',
      ],
    );
    let state = initial(source);
    for (const [a, d] of [
      ['clubs-3', 'clubs-4'],
      ['spades-4', 'diamonds-5'],
      ['hearts-5', 'diamonds-6'],
      ['clubs-6', 'diamonds-7'],
    ] as const) {
      state = defend(attack(state, a), d);
    }
    expect(state.attackCount).toBe(4);
    expect(state.hands.get('bob')).toHaveLength(4);
    expectCode(() => attack(state, 'spades-7'), 'ATTACK_LIMIT_REACHED');
    expect(
      applyTwoPlayerAction(state, { type: 'pass', playerId: 'alice' }).phase,
    ).toBe('awaiting-attack');
  });

  it('does not draw for hands at or over eight and exhausts short stock in order', () => {
    const attacked = attack(initial(), 'clubs-3');
    const allCards = [...attacked.stock];
    const short = allCards.slice(0, 1);
    const discard = [...attacked.discard, ...allCards.slice(1)];
    const custom = {
      ...attacked,
      stock: short,
      bottomCard: short.at(-1)!,
      discard,
    };
    const result = applyTwoPlayerAction(custom, {
      type: 'take',
      playerId: 'bob',
    });
    expect(result.stock).toHaveLength(0);
    expect(result.hands.get('alice')).toHaveLength(8);
    expect(result.hands.get('bob')).toHaveLength(9);
    assertTwoPlayerInvariant(result);
  });
});

describe('trump-two exchange and terminal results', () => {
  it('allows current and non-current players to exchange without changing the turn', () => {
    for (const holder of players) {
      const other = holder === 'alice' ? 'bob' : 'alice';
      const source = deal(
        holder === 'alice'
          ? [
              'diamonds-2',
              'clubs-3',
              'hearts-7',
              'spades-9',
              'diamonds-J',
              'clubs-K',
              'hearts-A',
              'spades-2',
            ]
          : undefined,
        holder === 'bob'
          ? [
              'diamonds-2',
              'clubs-4',
              'hearts-8',
              'spades-10',
              'diamonds-Q',
              'clubs-A',
              'hearts-2',
              'small-joker',
            ]
          : undefined,
      );
      const state = initial(source);
      const oldBottom = state.bottomCard!;
      const next = applyTwoPlayerAction(state, {
        type: 'exchange-trump-two',
        playerId: holder,
      });
      expect(next).toMatchObject({
        phase: state.phase,
        actor: state.actor,
        trumpSuit: state.trumpSuit,
        bottomCard: card('diamonds-2'),
      });
      expect(
        next.hands.get(holder)!.some((value) => value.id === oldBottom.id),
      ).toBe(true);
      expect(next.hands.get(other)).toEqual(state.hands.get(other));
    }
  });

  it('rejects invalid, repeated, and empty-stock exchanges', () => {
    const state = initial();
    expectCode(
      () =>
        applyTwoPlayerAction(state, {
          type: 'exchange-trump-two',
          playerId: 'alice',
        }),
      'TRUMP_TWO_UNAVAILABLE',
    );
    const withTwo = initial(
      deal([
        'diamonds-2',
        'clubs-3',
        'hearts-7',
        'spades-9',
        'diamonds-J',
        'clubs-K',
        'hearts-A',
        'spades-2',
      ]),
    );
    const exchanged = applyTwoPlayerAction(withTwo, {
      type: 'exchange-trump-two',
      playerId: 'alice',
    });
    expectCode(
      () =>
        applyTwoPlayerAction(exchanged, {
          type: 'exchange-trump-two',
          playerId: 'alice',
        }),
      'INDICATOR_ALREADY_EXCHANGED',
    );
    const noStock = {
      ...withTwo,
      stock: [],
      bottomCard: null,
      discard: [...withTwo.discard, ...withTwo.stock],
    };
    expectCode(
      () =>
        applyTwoPlayerAction(noStock, {
          type: 'exchange-trump-two',
          playerId: 'alice',
        }),
      'STOCK_EMPTY',
    );
  });

  it('awards an immediate empty-hand win to attacker and defender', () => {
    for (const role of ['attacker', 'defender'] as const) {
      let state = initial();
      const winner = state[role];
      const keep = role === 'attacker' ? 'clubs-3' : 'clubs-4';
      const moved = state.hands
        .get(winner)!
        .filter((value) => value.id !== keep);
      state = {
        ...state,
        hands: new Map(state.hands).set(winner, [card(keep)]),
        discard: [...state.discard, ...moved],
      };
      const finished =
        role === 'attacker'
          ? attack(state, keep)
          : defend(attack(state, 'clubs-3'), keep);
      expect(finished).toMatchObject({
        phase: 'finished',
        result: { winner, reason: 'emptied-hand' },
      });
    }
  });

  it('applies stuck-with-jokers before empty-hand victory and rejects later actions', () => {
    let state = initial(
      deal(
        [
          'clubs-3',
          'clubs-5',
          'hearts-7',
          'spades-9',
          'diamonds-J',
          'clubs-K',
          'hearts-A',
          'spades-2',
        ],
        [
          'clubs-4',
          'clubs-6',
          'hearts-8',
          'spades-10',
          'diamonds-Q',
          'clubs-A',
          'small-joker',
          'big-joker',
        ],
      ),
    );
    const bobHand = state.hands.get('bob')!;
    const moved = bobHand.filter((value) => value.kind !== 'joker');
    state = {
      ...state,
      hands: new Map(state.hands).set(
        'bob',
        bobHand.filter((value) => value.kind === 'joker'),
      ),
      discard: [...state.discard, ...moved],
    };
    const result = attack(state, 'clubs-3');
    expect(result).toMatchObject({
      phase: 'finished',
      result: {
        winner: 'alice',
        loser: 'bob',
        reason: 'opponent-stuck-with-jokers',
      },
    });
    expectCode(
      () => applyTwoPlayerAction(result, { type: 'pass', playerId: 'alice' }),
      'GAME_FINISHED',
    );
  });

  it('keeps all 54 unique cards after every successful action in a complete round', () => {
    let state = initial();
    const actions: TwoPlayerAction<(typeof players)[number]>[] = [
      { type: 'attack', playerId: 'alice', cardId: 'clubs-3' },
      { type: 'defend', playerId: 'bob', cardId: 'clubs-4' },
      { type: 'pass', playerId: 'alice' },
    ];
    for (const action of actions) {
      state = applyTwoPlayerAction(state, action);
      assertTwoPlayerInvariant(state);
    }
    expect(state.version).toBe(3);
  });
});

describe('stable errors', () => {
  it('uses the exported engine error class', () => {
    try {
      attack(initial(), 'small-joker');
    } catch (error) {
      expect(error).toBeInstanceOf(TwoPlayerEngineError);
    }
  });
});
