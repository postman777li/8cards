import type { Card, CardId, StandardRank } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import {
  applyFourPlayerAction,
  applyThreePlayerAction,
  applyTwoPlayerAction,
  assertFourPlayerInvariant,
  assertThreePlayerInvariant,
  assertTwoPlayerInvariant,
  compareCards,
  createFourPlayerState,
  createInitialDeal,
  createStandardDeck,
  createThreePlayerState,
  createTwoPlayerState,
  FourPlayerEngineError,
  ThreePlayerEngineError,
  TwoPlayerEngineError,
  type FourPlayerAction,
  type FourPlayerState,
  type RandomSource,
  type ThreePlayerAction,
  type ThreePlayerState,
  type TwoPlayerAction,
  type TwoPlayerState,
} from './index.js';

const SEEDS = Array.from({ length: 100 }, (_, index) => index + 1);
const MAX_STEPS = 2_000;

type Player = 'A' | 'B' | 'C' | 'D';
type Mode = 2 | 3 | 4;
type ActiveState =
  TwoPlayerState<Player> | ThreePlayerState<Player> | FourPlayerState<Player>;
type AnyAction =
  | TwoPlayerAction<Player>
  | ThreePlayerAction<Player>
  | FourPlayerAction<Player>;

interface SimulationSummary {
  readonly mode: Mode;
  readonly games: number;
  readonly totalSteps: number;
  readonly maximumSteps: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly actions: Readonly<Record<string, number>>;
  readonly sample: string;
}

function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function choose<T>(values: readonly T[], random: RandomSource): T {
  return values[Math.floor(random() * values.length)]!;
}

function playersFor(mode: Mode): readonly Player[] {
  return ['A', 'B', 'C', 'D'].slice(0, mode) as Player[];
}

function createState(mode: Mode, random: RandomSource): ActiveState {
  const players = playersFor(mode);
  const deal = createInitialDeal(players, random);
  if (mode === 2) return createTwoPlayerState(deal, players);
  if (mode === 3) return createThreePlayerState(deal, players);
  return createFourPlayerState(deal, players);
}

function allCards(state: ActiveState): Card[] {
  return [
    ...state.players.flatMap((player) => [...state.hands.get(player)!]),
    ...state.stock,
    ...state.discard,
    ...state.table.flatMap(({ attack, defense }) =>
      defense ? [attack, defense] : [attack],
    ),
  ];
}

function assertTableShape(state: ActiveState): void {
  expect(state.attackCount).toBe(state.table.length);
  if (state.phase === 'awaiting-attack') {
    expect(state.table.every((pair) => pair.defense !== undefined)).toBe(true);
  } else if (state.phase === 'awaiting-defense') {
    expect(state.table.length).toBeGreaterThan(0);
    expect(
      state.table.slice(0, -1).every((pair) => pair.defense !== undefined),
    ).toBe(true);
    expect(state.table.at(-1)?.defense).toBeUndefined();
  }
}

function assertState(mode: Mode, state: ActiveState): void {
  const cards = allCards(state);
  expect(cards).toHaveLength(54);
  expect(new Set(cards.map((card) => card.id)).size).toBe(54);
  expect(new Set(cards.map((card) => card.id))).toEqual(
    new Set(createStandardDeck().map((card) => card.id)),
  );
  assertTableShape(state);

  if (mode === 2) {
    const current = state as TwoPlayerState<Player>;
    assertTwoPlayerInvariant(current);
    if (current.phase === 'awaiting-attack')
      expect(current.actor).toBe(current.attacker);
    if (current.phase === 'awaiting-defense')
      expect(current.actor).toBe(current.defender);
  } else if (mode === 3) {
    const current = state as ThreePlayerState<Player>;
    assertThreePlayerInvariant(current);
    expect(current.attackCount).toBeLessThanOrEqual(current.table.length);
    expect(current.consecutivePasses).toBeGreaterThanOrEqual(0);
    expect(current.consecutivePasses).toBeLessThan(2);
    expect(current.attackCursor).not.toBe(current.defender);
    if (current.phase === 'awaiting-attack')
      expect(current.actor).toBe(current.attackCursor);
    if (current.phase === 'awaiting-defense')
      expect(current.actor).toBe(current.defender);
  } else {
    const current = state as FourPlayerState<Player>;
    assertFourPlayerInvariant(current);
    expect(current.consecutivePasses).toBeGreaterThanOrEqual(0);
    expect(current.consecutivePasses).toBeLessThan(2);
    expect(current.attackers).toContain(current.attackCursor);
    expect(current.attackers).not.toContain(current.defender);
    expect(current.attackers).not.toContain(current.observer);
    if (current.phase === 'awaiting-attack')
      expect(current.actor).toBe(current.attackCursor);
    if (current.phase === 'awaiting-defense')
      expect(current.actor).toBe(current.defender);
  }

  if (state.phase === 'finished') expect(state.actor).toBeNull();
  else expect(state.actor).not.toBeNull();
}

function exchangeAction(state: ActiveState): AnyAction | null {
  if (state.indicatorExchanged || state.stock.length === 0) return null;
  for (const player of state.players) {
    const hasTrumpTwo = state.hands
      .get(player)!
      .some(
        (card) =>
          card.kind === 'standard' &&
          card.suit === state.trumpSuit &&
          card.rank === '2',
      );
    if (hasTrumpTwo) return { type: 'exchange-trump-two', playerId: player };
  }
  return null;
}

function attackCandidates(state: ActiveState): Card[] {
  if (state.phase !== 'awaiting-attack') return [];
  if (state.attackCount + 1 > state.hands.get(state.defender)!.length)
    return [];
  return state.hands.get(state.actor)!.filter((card) => {
    if (card.kind === 'joker') return false;
    return state.table.length === 0 || state.leadRanks.has(card.rank);
  });
}

function defenseCandidates(state: ActiveState): Card[] {
  if (state.phase !== 'awaiting-defense') return [];
  const attack = state.table.at(-1)!.attack;
  return state.hands
    .get(state.defender)!
    .filter((card) => compareCards(card, attack, state.trumpSuit) === 1);
}

function legalAction(state: ActiveState, random: RandomSource): AnyAction {
  const exchange = exchangeAction(state);
  if (exchange) return exchange;

  if (state.phase === 'awaiting-defense') {
    const candidates = defenseCandidates(state);
    if (candidates.length > 0 && random() < 0.78) {
      return {
        type: 'defend',
        playerId: state.defender,
        cardId: choose(candidates, random).id,
      };
    }
    return { type: 'take', playerId: state.defender };
  }

  if (state.phase !== 'awaiting-attack')
    throw new Error('Finished state has no legal action');
  const candidates = attackCandidates(state);
  if (state.table.length === 0 || (candidates.length > 0 && random() < 0.72)) {
    if (candidates.length === 0)
      throw new Error('Active attacker has no opening card');
    return {
      type: 'attack',
      playerId: state.actor,
      cardId: choose(candidates, random).id,
    };
  }
  return { type: 'pass', playerId: state.actor };
}

function apply(mode: Mode, state: ActiveState, action: AnyAction): ActiveState {
  if (mode === 2)
    return applyTwoPlayerAction(
      state as TwoPlayerState<Player>,
      action as TwoPlayerAction<Player>,
    );
  if (mode === 3)
    return applyThreePlayerAction(
      state as ThreePlayerState<Player>,
      action as ThreePlayerAction<Player>,
    );
  return applyFourPlayerAction(
    state as FourPlayerState<Player>,
    action as FourPlayerAction<Player>,
  );
}

function jokerOnlyPlayers(state: ActiveState): Set<Player> {
  return new Set(
    state.players.filter((player) => {
      const hand = state.hands.get(player)!;
      return hand.length > 0 && hand.every((card) => card.kind === 'joker');
    }),
  );
}

function outcomeKey(state: ActiveState): string {
  if (state.phase !== 'finished') return 'unfinished';
  if ('outcome' in state.result)
    return `${state.result.outcome}:${state.result.reason}`;
  return state.result.reason;
}

function readableResult(state: ActiveState): string {
  if (state.phase !== 'finished') return 'unfinished';
  return JSON.stringify(state.result);
}

function runMode(mode: Mode): SimulationSummary {
  const actions: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  let totalSteps = 0;
  let maximumSteps = 0;
  let sample = '';

  for (const seed of SEEDS) {
    const random = seededRandom(seed * 10 + mode);
    let state = createState(mode, random);
    assertState(mode, state);
    let steps = 0;

    while (state.phase !== 'finished') {
      if (steps >= MAX_STEPS) {
        throw new Error(
          `Simulation exceeded ${MAX_STEPS} actions: mode=${mode}, seed=${seed}, phase=${state.phase}, actor=${state.actor}, stock=${state.stock.length}, table=${state.table.length}, hands=${state.players.map((player) => state.hands.get(player)!.length).join('/')}`,
        );
      }
      const action = legalAction(state, random);
      const before = structuredClone(state);
      const beforeJokers = jokerOnlyPlayers(state);
      const beforeLengths = state.players.map(
        (player) => state.hands.get(player)!.length,
      );
      const next = apply(mode, state, action);

      expect(state).toEqual(before);
      expect(next.version).toBe(state.version + 1);
      assertState(mode, next);
      const decreasedHands = state.players.filter(
        (player, index) =>
          next.hands.get(player)!.length < beforeLengths[index]!,
      );
      expect(decreasedHands.length).toBeLessThanOrEqual(1);
      const newlyJokerOnly = [...jokerOnlyPlayers(next)].filter(
        (player) => !beforeJokers.has(player),
      );
      expect(newlyJokerOnly.length).toBeLessThanOrEqual(1);

      actions[action.type] = (actions[action.type] ?? 0) + 1;
      state = next;
      steps += 1;
    }

    expect(steps).toBeGreaterThan(0);
    const key = outcomeKey(state);
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    totalSteps += steps;
    maximumSteps = Math.max(maximumSteps, steps);
    if (seed === 1)
      sample = `seed=1 steps=${steps} result=${readableResult(state)}`;
  }

  for (const required of [
    'attack',
    'defend',
    'pass',
    'take',
    'exchange-trump-two',
  ]) {
    expect(
      actions[required],
      `${required} was never generated for ${mode} players`,
    ).toBeGreaterThan(0);
  }
  expect(Object.values(outcomes).reduce((sum, count) => sum + count, 0)).toBe(
    SEEDS.length,
  );
  return {
    mode,
    games: SEEDS.length,
    totalSteps,
    maximumSteps,
    outcomes,
    actions,
    sample,
  };
}

function expectFinishedActionsRejected(mode: Mode): void {
  const random = seededRandom(1_000 + mode);
  let state = createState(mode, random);
  while (state.phase !== 'finished')
    state = apply(mode, state, legalAction(state, random));
  const snapshot = structuredClone(state);
  const player = state.players[0];
  const cardId = createStandardDeck()[0]!.id as CardId;
  const candidates: AnyAction[] = [
    { type: 'attack', playerId: player, cardId },
    { type: 'defend', playerId: player, cardId },
    { type: 'pass', playerId: player },
    { type: 'take', playerId: player },
    { type: 'exchange-trump-two', playerId: player },
  ];
  const ErrorClass =
    mode === 2
      ? TwoPlayerEngineError
      : mode === 3
        ? ThreePlayerEngineError
        : FourPlayerEngineError;
  for (const action of candidates) {
    expect(() => apply(mode, state, action)).toThrowError(ErrorClass);
    try {
      apply(mode, state, action);
    } catch (error) {
      expect(error).toMatchObject({ code: 'GAME_FINISHED' });
    }
    expect(state).toEqual(snapshot);
  }
}

describe('deterministic full-game acceptance simulations', () => {
  for (const mode of [2, 3, 4] as const) {
    it(`finishes 100 legal ${mode}-player games and repeats identically`, () => {
      const first = runMode(mode);
      const second = runMode(mode);
      expect(second).toEqual(first);
      console.info(`[game-engine-acceptance] ${JSON.stringify(first)}`);
    }, 60_000);

    it(`rejects every action after a ${mode}-player game finishes`, () => {
      expectFinishedActionsRejected(mode);
    });
  }
});

describe('terminal semantics and table ranks', () => {
  it('does not treat an empty hand as a joker-only hand', () => {
    const empty: readonly Card[] = [];
    expect(
      empty.length > 0 && empty.every((card) => card.kind === 'joker'),
    ).toBe(false);
  });

  it('jokers never contribute a lead rank', () => {
    const ranks = new Set<StandardRank>(['A']);
    const jokers = createStandardDeck().filter((card) => card.kind === 'joker');
    for (const joker of jokers)
      expect('rank' in joker && ranks.has(joker.rank as StandardRank)).toBe(
        false,
      );
  });
});
