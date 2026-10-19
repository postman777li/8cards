import { describe, expect, it } from 'vitest';
import type { CardId } from '@8cards/shared';
import {
  createInitialDeal,
  createStandardDeck,
  createTwoPlayerState,
  createThreePlayerState,
  createFourPlayerState,
  applyTwoPlayerAction,
  applyThreePlayerAction,
  applyFourPlayerAction,
  resolveTwoPlayerState,
  resolveThreePlayerState,
  resolveFourPlayerState,
  assertTwoPlayerInvariant,
  assertThreePlayerInvariant,
  assertFourPlayerInvariant,
  type TwoPlayerState,
  type ThreePlayerState,
  type FourPlayerState,
  type TwoPlayerAction,
} from './index.js';

type State = TwoPlayerState | ThreePlayerState | FourPlayerState;
const ids = ['A', 'B', 'C', 'D'];
const deck = createStandardDeck();
const card = (id: string) => deck.find((c) => c.id === id)!;

function harness(mode: 2 | 3 | 4) {
  const players = ids.slice(0, mode);
  const deal = { ...createInitialDeal(players, () => 0.3), firstDefender: 'B' };
  const initial =
    mode === 2
      ? createTwoPlayerState(deal, players)
      : mode === 3
        ? createThreePlayerState(deal, players)
        : createFourPlayerState(deal, players);
  const act = (s: State, action: TwoPlayerAction) =>
    mode === 2
      ? applyTwoPlayerAction(s as TwoPlayerState, action)
      : mode === 3
        ? applyThreePlayerAction(s as ThreePlayerState, action)
        : applyFourPlayerAction(s as FourPlayerState, action);
  const resolve = (s: State) =>
    mode === 2
      ? resolveTwoPlayerState(s as TwoPlayerState)
      : mode === 3
        ? resolveThreePlayerState(s as ThreePlayerState)
        : resolveFourPlayerState(s as FourPlayerState);
  const invariant = (s: State) =>
    mode === 2
      ? assertTwoPlayerInvariant(s as TwoPlayerState)
      : mode === 3
        ? assertThreePlayerInvariant(s as ThreePlayerState)
        : assertFourPlayerInvariant(s as FourPlayerState);
  const fixture = (
    assignments: Record<string, string[]>,
    stock: string[] = [],
  ) => {
    const defaults: Record<string, string[]> = {
      A: ['clubs-3', 'hearts-5'],
      B: ['clubs-4', 'hearts-6'],
      C: ['clubs-6', 'hearts-7'],
      D: ['clubs-8', 'hearts-9'],
    };
    const hands = new Map(
      players.map((id) => [id, (assignments[id] ?? defaults[id]!).map(card)]),
    );
    const used = new Set(
      [...hands.values()]
        .flat()
        .map((c) => c.id)
        .concat(stock as CardId[]),
    );
    return {
      ...initial,
      phase: 'awaiting-attack',
      actor: 'A',
      result: null,
      hands,
      stock: stock.map(card),
      bottomCard: stock.length ? card(stock.at(-1)!) : null,
      discard: deck.filter((c) => !used.has(c.id)),
    } as State;
  };
  const attack = (s: State) =>
    act(s, { type: 'attack', playerId: 'A', cardId: 'clubs-3' as CardId });
  const defend = (s: State, id = 'clubs-4') =>
    act(s, { type: 'defend', playerId: 'B', cardId: id as CardId });
  const finishDefense = (s: State) => {
    if (mode > 2) s = act(s, { type: 'pass', playerId: 'C' });
    return act(s, { type: 'pass', playerId: 'A' });
  };
  return { fixture, attack, defend, finishDefense, resolve, act, invariant };
}

describe.each([2, 3, 4] as const)(
  '%i-player mandatory-opening joker rule',
  (mode) => {
    const h = harness(mode);
    it('keeps a pure-joker defender alive across a non-turn trump-two exchange', () => {
      const before = h.fixture(
        { A: ['diamonds-2', 'clubs-3'], B: ['small-joker', 'big-joker'] },
        ['diamonds-3'],
      );
      const after = h.act(
        { ...before, trumpSuit: 'diamonds' },
        {
          type: 'exchange-trump-two',
          playerId: 'A',
        },
      );
      expect(after.phase).toBe('awaiting-attack');
      expect(after.actor).toBe('A');
      expect(after.hands.get('B')!.every((c) => c.kind === 'joker')).toBe(true);
      h.invariant(after);
    });

    it('does not lose after attacking the last ordinary card', () => {
      const before = h.fixture({ A: ['clubs-3', 'small-joker'] });
      const after = h.attack(before);
      expect(after.phase).toBe('awaiting-defense');
      expect(after.hands.get('A')!.map((c) => c.kind)).toEqual(['joker']);
      expect(before.hands.get('A')).toHaveLength(2);
      h.invariant(after);
    });
    it('allows a pure-joker defender to defend and finish normally', () => {
      const after = h.defend(
        h.attack(h.fixture({ B: ['small-joker'] })),
        'small-joker',
      );
      expect(after.phase).toBe('finished');
      expect(after.result?.reason).toBe('emptied-hand');
      h.invariant(after);
    });
    it.each([['small-joker'], ['small-joker', 'big-joker']])(
      'resolves a forced opening with %j immediately',
      (...jokerIds) => {
        const state = h.resolve(h.fixture({ A: jokerIds as string[] }));
        expect(state.phase).toBe('finished');
        expect(state.result?.reason).toMatch(/stuck-with-jokers/);
        h.invariant(state);
      },
    );
    it('waits until defense settlement before failing the new pure-joker main attacker', () => {
      const defended = h.defend(
        h.attack(h.fixture({ B: ['clubs-4', 'small-joker'] })),
      );
      expect(defended.phase).toBe('awaiting-attack');
      const result = h.finishDefense(defended);
      expect(result.phase).toBe('finished');
      expect(result.result?.reason).toMatch(/stuck-with-jokers/);
      h.invariant(result);
    });
    it('replenishes before checking the next mandatory opening', () => {
      const result = h.finishDefense(
        h.defend(
          h.attack(
            h.fixture(
              {
                A: [
                  'clubs-3',
                  'clubs-5',
                  'clubs-7',
                  'clubs-9',
                  'clubs-10',
                  'clubs-J',
                  'clubs-Q',
                  'clubs-K',
                ],
                B: ['clubs-4', 'small-joker'],
              },
              [
                'diamonds-8',
                'diamonds-9',
                'diamonds-10',
                'diamonds-J',
                'diamonds-Q',
                'diamonds-K',
                'diamonds-A',
              ],
            ),
          ),
        ),
      );
      expect(result.phase).toBe('awaiting-attack');
      expect(result.hands.get('B')!.some((c) => c.kind === 'standard')).toBe(
        true,
      );
      h.invariant(result);
    });
    it('resolves the next mandatory attacker after collecting', () => {
      const state = h.fixture(
        mode === 2 ? { A: ['clubs-3', 'small-joker'] } : { C: ['small-joker'] },
      );
      const result = h.act(h.attack(state), { type: 'take', playerId: 'B' });
      expect(result.phase).toBe('finished');
      expect(result.result?.reason).toMatch(/stuck-with-jokers/);
      h.invariant(result);
    });
    if (mode > 2)
      it('lets a pure-joker second attacker pass without losing', () => {
        const defended = h.defend(
          h.attack(h.fixture({ C: ['small-joker', 'big-joker'] })),
        );
        const result = h.act(defended, { type: 'pass', playerId: 'C' });
        expect(result.phase).toBe('awaiting-attack');
        expect(result.actor).toBe('A');
        h.invariant(result);
      });
  },
);
