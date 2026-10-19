import {
  cardSchema,
  type Card,
  type CardId,
  type StandardRank,
  type Suit,
} from '@8cards/shared';

import { createStandardDeck } from './cards.js';
import type { InitialDeal } from './deal.js';
import { compareCards } from './strength.js';

export const TWO_PLAYER_ERROR_CODES = [
  'INVALID_INITIAL_STATE',
  'GAME_FINISHED',
  'WRONG_ACTOR',
  'WRONG_PHASE',
  'CARD_NOT_IN_HAND',
  'JOKER_CANNOT_ATTACK',
  'RANK_NOT_ON_TABLE',
  'ATTACK_LIMIT_REACHED',
  'CARD_CANNOT_BEAT_ATTACK',
  'TRUMP_TWO_UNAVAILABLE',
  'STOCK_EMPTY',
  'INDICATOR_ALREADY_EXCHANGED',
] as const;

export type TwoPlayerErrorCode = (typeof TWO_PLAYER_ERROR_CODES)[number];

export class TwoPlayerEngineError extends Error {
  readonly name = 'TwoPlayerEngineError';

  constructor(
    readonly code: TwoPlayerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TablePair {
  readonly attack: Card;
  readonly defense?: Card;
}

export interface TwoPlayerResult<PlayerId extends string = string> {
  readonly winner: PlayerId;
  readonly loser: PlayerId;
  readonly reason: 'emptied-hand' | 'opponent-stuck-with-jokers';
}

interface StateData<PlayerId extends string> {
  readonly players: readonly [PlayerId, PlayerId];
  readonly hands: ReadonlyMap<PlayerId, readonly Card[]>;
  readonly stock: readonly Card[];
  readonly discard: readonly Card[];
  readonly trumpSuit: Suit;
  readonly bottomCard: Card | null;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly table: readonly TablePair[];
  readonly leadRanks: ReadonlySet<StandardRank>;
  readonly attackCount: number;
  readonly roundAttackLimit: number;
  readonly indicatorExchanged: boolean;
  readonly version: number;
}

export interface AwaitingAttackState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'awaiting-attack';
  readonly actor: PlayerId;
  readonly result: null;
}

export interface AwaitingDefenseState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'awaiting-defense';
  readonly actor: PlayerId;
  readonly result: null;
  readonly table: readonly TablePair[];
}

export interface FinishedState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'finished';
  readonly actor: null;
  readonly result: TwoPlayerResult<PlayerId>;
}

export type TwoPlayerState<PlayerId extends string = string> =
  | AwaitingAttackState<PlayerId>
  | AwaitingDefenseState<PlayerId>
  | FinishedState<PlayerId>;

export type TwoPlayerAction<PlayerId extends string = string> =
  | {
      readonly type: 'attack';
      readonly playerId: PlayerId;
      readonly cardId: CardId;
    }
  | {
      readonly type: 'defend';
      readonly playerId: PlayerId;
      readonly cardId: CardId;
    }
  | { readonly type: 'pass'; readonly playerId: PlayerId }
  | { readonly type: 'take'; readonly playerId: PlayerId }
  | { readonly type: 'exchange-trump-two'; readonly playerId: PlayerId };

function fail(code: TwoPlayerErrorCode, message: string): never {
  throw new TwoPlayerEngineError(code, message);
}

function validateCards(cards: readonly Card[]): void {
  const expected = new Set(createStandardDeck().map((card) => card.id));
  const seen = new Set<string>();
  for (const value of cards) {
    const card = cardSchema.safeParse(value);
    if (!card.success) {
      fail(
        'INVALID_INITIAL_STATE',
        'Cards must be one complete unique standard deck',
      );
    }
    if (!expected.has(card.data.id) || seen.has(card.data.id)) {
      fail(
        'INVALID_INITIAL_STATE',
        'Cards must be one complete unique standard deck',
      );
    }
    seen.add(card.data.id);
  }
  if (cards.length !== 54 || seen.size !== 54) {
    fail(
      'INVALID_INITIAL_STATE',
      'Cards must be one complete unique standard deck',
    );
  }
}

function allCards<PlayerId extends string>(state: StateData<PlayerId>): Card[] {
  return [
    ...state.players.flatMap((player) => [...(state.hands.get(player) ?? [])]),
    ...state.stock,
    ...state.discard,
    ...state.table.flatMap(({ attack, defense }) =>
      defense ? [attack, defense] : [attack],
    ),
  ];
}

export function assertTwoPlayerInvariant<PlayerId extends string>(
  state: StateData<PlayerId>,
): void {
  validateCards(allCards(state));
  if (state.bottomCard?.id !== state.stock.at(-1)?.id) {
    fail(
      'INVALID_INITIAL_STATE',
      'Bottom card must match the bottom of the stock',
    );
  }
}

function terminalResult<PlayerId extends string>(
  state: StateData<PlayerId> & {
    readonly phase: 'awaiting-attack' | 'awaiting-defense';
    readonly actor: PlayerId;
  },
): TwoPlayerResult<PlayerId> | null {
  for (const player of state.players) {
    const hand = state.hands.get(player)!;
    if (
      state.phase === 'awaiting-attack' &&
      state.actor === player &&
      state.table.length === 0 &&
      player === state.attacker &&
      hand.length > 0 &&
      hand.every((card) => card.kind === 'joker')
    ) {
      const winner = state.players.find((candidate) => candidate !== player)!;
      return { winner, loser: player, reason: 'opponent-stuck-with-jokers' };
    }
  }
  for (const player of state.players) {
    if (state.hands.get(player)!.length === 0) {
      const loser = state.players.find((candidate) => candidate !== player)!;
      return { winner: player, loser, reason: 'emptied-hand' };
    }
  }
  return null;
}

function finalize<PlayerId extends string>(
  state: AwaitingAttackState<PlayerId> | AwaitingDefenseState<PlayerId>,
): TwoPlayerState<PlayerId> {
  assertTwoPlayerInvariant(state);
  const result = terminalResult(state);
  if (!result) return state;
  return { ...state, phase: 'finished', actor: null, result };
}

export function createTwoPlayerState<PlayerId extends string>(
  deal: InitialDeal<PlayerId>,
  players: readonly PlayerId[],
): TwoPlayerState<PlayerId> {
  if (players.length !== 2 || new Set(players).size !== 2) {
    fail('INVALID_INITIAL_STATE', 'Two distinct players are required');
  }
  const tuple = players as unknown as readonly [PlayerId, PlayerId];
  if (!players.includes(deal.firstDefender) || deal.hands.size !== 2) {
    fail('INVALID_INITIAL_STATE', 'Initial deal players do not match');
  }
  for (const player of players) {
    if (!deal.hands.has(player) || deal.hands.get(player)!.length !== 8) {
      fail(
        'INVALID_INITIAL_STATE',
        'Each player must have exactly eight cards',
      );
    }
  }
  if (
    deal.indicator.kind !== 'standard' ||
    deal.indicator.suit !== deal.trumpSuit ||
    deal.stock.at(-1)?.id !== deal.indicator.id
  ) {
    fail(
      'INVALID_INITIAL_STATE',
      'Indicator and stock bottom are inconsistent',
    );
  }
  const attacker = players.find((player) => player !== deal.firstDefender)!;
  const state: AwaitingAttackState<PlayerId> = {
    phase: 'awaiting-attack',
    players: tuple,
    hands: new Map(
      players.map((player) => [player, [...deal.hands.get(player)!]]),
    ),
    stock: [...deal.stock],
    discard: [],
    trumpSuit: deal.trumpSuit,
    bottomCard: deal.stock.at(-1) ?? null,
    attacker,
    defender: deal.firstDefender,
    actor: attacker,
    table: [],
    leadRanks: new Set(),
    attackCount: 0,
    roundAttackLimit: deal.hands.get(deal.firstDefender)!.length,
    indicatorExchanged: false,
    version: 0,
    result: null,
  };
  assertTwoPlayerInvariant(state);
  return finalize(state);
}

function removeCard<PlayerId extends string>(
  state: StateData<PlayerId>,
  player: PlayerId,
  cardId: CardId,
): { hands: ReadonlyMap<PlayerId, readonly Card[]>; card: Card } {
  const hand = state.hands.get(player) ?? [];
  const index = hand.findIndex((card) => card.id === cardId);
  if (index < 0) fail('CARD_NOT_IN_HAND', 'Card is not in the player hand');
  const nextHand = [...hand];
  const [card] = nextHand.splice(index, 1);
  return { hands: new Map(state.hands).set(player, nextHand), card: card! };
}

function requireActor<PlayerId extends string>(
  state: TwoPlayerState<PlayerId>,
  player: PlayerId,
): void {
  if (!state.players.includes(player)) fail('WRONG_ACTOR', 'Unknown player');
  if (state.actor !== player)
    fail('WRONG_ACTOR', 'It is not this player’s turn');
}

function addRank(
  ranks: ReadonlySet<StandardRank>,
  card: Card,
): ReadonlySet<StandardRank> {
  return card.kind === 'standard'
    ? new Set([...ranks, card.rank])
    : new Set(ranks);
}

function replenish<PlayerId extends string>(
  hands: ReadonlyMap<PlayerId, readonly Card[]>,
  stock: readonly Card[],
  order: readonly [PlayerId, PlayerId],
): { hands: ReadonlyMap<PlayerId, readonly Card[]>; stock: readonly Card[] } {
  const nextHands = new Map(hands);
  const nextStock = [...stock];
  for (const player of order) {
    const hand = [...nextHands.get(player)!];
    while (hand.length < 8 && nextStock.length > 0)
      hand.push(nextStock.shift()!);
    nextHands.set(player, hand);
  }
  return { hands: nextHands, stock: nextStock };
}

function settle<PlayerId extends string>(
  state: AwaitingAttackState<PlayerId> | AwaitingDefenseState<PlayerId>,
  kind: 'defended' | 'taken',
): TwoPlayerState<PlayerId> {
  const tableCards = state.table.flatMap(({ attack, defense }) =>
    defense ? [attack, defense] : [attack],
  );
  const hands = new Map(state.hands);
  let discard = [...state.discard];
  if (kind === 'taken')
    hands.set(state.defender, [...hands.get(state.defender)!, ...tableCards]);
  else discard = [...discard, ...tableCards];
  const replenished = replenish(hands, state.stock, [
    state.attacker,
    state.defender,
  ]);
  const attacker = kind === 'defended' ? state.defender : state.attacker;
  const defender = kind === 'defended' ? state.attacker : state.defender;
  return finalize({
    ...state,
    phase: 'awaiting-attack',
    hands: replenished.hands,
    stock: replenished.stock,
    discard,
    bottomCard: replenished.stock.at(-1) ?? null,
    attacker,
    defender,
    actor: attacker,
    table: [],
    leadRanks: new Set(),
    attackCount: 0,
    roundAttackLimit: replenished.hands.get(defender)!.length,
    version: state.version + 1,
    result: null,
  });
}

function exchangeTrumpTwo<PlayerId extends string>(
  state: AwaitingAttackState<PlayerId> | AwaitingDefenseState<PlayerId>,
  player: PlayerId,
): TwoPlayerState<PlayerId> {
  if (!state.players.includes(player)) fail('WRONG_ACTOR', 'Unknown player');
  if (state.indicatorExchanged)
    fail('INDICATOR_ALREADY_EXCHANGED', 'Indicator was already exchanged');
  if (state.stock.length === 0) fail('STOCK_EMPTY', 'Stock has no bottom card');
  const trumpTwo = state.hands
    .get(player)!
    .find(
      (card) =>
        card.kind === 'standard' &&
        card.suit === state.trumpSuit &&
        card.rank === '2',
    );
  if (!trumpTwo)
    fail('TRUMP_TWO_UNAVAILABLE', 'Player does not hold the trump two');
  const removed = removeCard(state, player, trumpTwo.id);
  const stock = [...state.stock];
  const indicator = stock.pop()!;
  stock.push(removed.card);
  const hands = new Map(removed.hands).set(player, [
    ...removed.hands.get(player)!,
    indicator,
  ]);
  return finalize({
    ...state,
    hands,
    stock,
    bottomCard: removed.card,
    indicatorExchanged: true,
    version: state.version + 1,
    result: null,
  });
}

export function applyTwoPlayerAction<PlayerId extends string>(
  state: TwoPlayerState<PlayerId>,
  action: TwoPlayerAction<PlayerId>,
): TwoPlayerState<PlayerId> {
  if (state.phase === 'finished')
    fail('GAME_FINISHED', 'The game is already finished');
  const activeState:
    AwaitingAttackState<PlayerId> | AwaitingDefenseState<PlayerId> = state;
  if (action.type === 'exchange-trump-two')
    return exchangeTrumpTwo(activeState, action.playerId);

  if (action.type === 'take') {
    if (action.playerId !== activeState.defender)
      fail('WRONG_ACTOR', 'Only the defender can take the table');
    if (activeState.table.length === 0)
      fail('WRONG_PHASE', 'The table is empty');
    return settle(activeState, 'taken');
  }

  requireActor(activeState, action.playerId);
  if (action.type === 'attack') {
    if (activeState.phase !== 'awaiting-attack')
      fail('WRONG_PHASE', 'An attack is not expected');
    const state = activeState;
    const handCard = state.hands
      .get(action.playerId)!
      .find((card) => card.id === action.cardId);
    if (!handCard) fail('CARD_NOT_IN_HAND', 'Card is not in the player hand');
    if (handCard.kind === 'joker')
      fail('JOKER_CANNOT_ATTACK', 'Jokers cannot be used to attack');
    if (state.table.length > 0 && !state.leadRanks.has(handCard.rank)) {
      fail('RANK_NOT_ON_TABLE', 'Attack rank has not appeared on the table');
    }
    if (state.attackCount + 1 > state.roundAttackLimit) {
      fail('ATTACK_LIMIT_REACHED', 'Fixed round attack limit has been reached');
    }
    const removed = removeCard(state, action.playerId, action.cardId);
    return finalize({
      ...state,
      phase: 'awaiting-defense',
      hands: removed.hands,
      actor: state.defender,
      table: [...state.table, { attack: removed.card }],
      leadRanks: addRank(state.leadRanks, removed.card),
      attackCount: state.attackCount + 1,
      version: state.version + 1,
      result: null,
    });
  }
  if (action.type === 'pass') {
    if (activeState.phase !== 'awaiting-attack')
      fail('WRONG_PHASE', 'Passing is not expected');
    if (activeState.table.length === 0)
      fail('WRONG_PHASE', 'The primary attacker must open the round');
    return settle(activeState, 'defended');
  }
  if (activeState.phase !== 'awaiting-defense')
    fail('WRONG_PHASE', 'A defense is not expected');
  const defenseState = activeState;
  const unresolved = defenseState.table.at(-1)!;
  const defendingCard = defenseState.hands
    .get(action.playerId)!
    .find((card) => card.id === action.cardId);
  if (!defendingCard)
    fail('CARD_NOT_IN_HAND', 'Card is not in the player hand');
  if (
    compareCards(defendingCard, unresolved.attack, defenseState.trumpSuit) !== 1
  ) {
    fail(
      'CARD_CANNOT_BEAT_ATTACK',
      'Defense card does not beat the attack card',
    );
  }
  const removed = removeCard(defenseState, action.playerId, action.cardId);
  const table = defenseState.table.map((pair, index) =>
    index === defenseState.table.length - 1
      ? { ...pair, defense: removed.card }
      : pair,
  );
  return finalize({
    ...defenseState,
    phase: 'awaiting-attack',
    hands: removed.hands,
    actor: defenseState.attacker,
    table,
    leadRanks: addRank(defenseState.leadRanks, removed.card),
    version: defenseState.version + 1,
    result: null,
  });
}

export function resolveTwoPlayerState<PlayerId extends string>(
  state: TwoPlayerState<PlayerId>,
): TwoPlayerState<PlayerId> {
  return state.phase === 'finished' ? state : finalize(state);
}
