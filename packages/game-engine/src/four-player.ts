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
import type { TablePair } from './two-player.js';

export const FOUR_PLAYER_ERROR_CODES = [
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
export type FourPlayerErrorCode = (typeof FOUR_PLAYER_ERROR_CODES)[number];

export class FourPlayerEngineError extends Error {
  readonly name = 'FourPlayerEngineError';
  constructor(
    readonly code: FourPlayerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FourPlayerTeam<PlayerId extends string = string> {
  readonly id: 0 | 1;
  readonly members: readonly [PlayerId, PlayerId];
}
export type FourPlayerResult<PlayerId extends string = string> = {
  readonly winningTeam: FourPlayerTeam<PlayerId>;
  readonly losingTeam: FourPlayerTeam<PlayerId>;
  readonly triggerPlayer: PlayerId;
  readonly reason: 'emptied-hand' | 'stuck-with-jokers';
};

interface StateData<PlayerId extends string> {
  readonly players: readonly [PlayerId, PlayerId, PlayerId, PlayerId];
  readonly teams: readonly [FourPlayerTeam<PlayerId>, FourPlayerTeam<PlayerId>];
  readonly hands: ReadonlyMap<PlayerId, readonly Card[]>;
  readonly stock: readonly Card[];
  readonly discard: readonly Card[];
  readonly trumpSuit: Suit;
  readonly bottomCard: Card | null;
  readonly roundAttacker: PlayerId;
  readonly defender: PlayerId;
  readonly observer: PlayerId;
  readonly attackers: readonly [PlayerId, PlayerId];
  readonly attackCursor: PlayerId;
  readonly table: readonly TablePair[];
  readonly leadRanks: ReadonlySet<StandardRank>;
  readonly attackCount: number;
  readonly roundAttackLimit: number;
  readonly consecutivePasses: number;
  readonly indicatorExchanged: boolean;
  readonly version: number;
}
export interface FourPlayerAwaitingAttackState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'awaiting-attack';
  readonly actor: PlayerId;
  readonly result: null;
}
export interface FourPlayerAwaitingDefenseState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'awaiting-defense';
  readonly actor: PlayerId;
  readonly result: null;
}
export interface FourPlayerFinishedState<
  PlayerId extends string = string,
> extends StateData<PlayerId> {
  readonly phase: 'finished';
  readonly actor: null;
  readonly result: FourPlayerResult<PlayerId>;
}
export type FourPlayerState<PlayerId extends string = string> =
  | FourPlayerAwaitingAttackState<PlayerId>
  | FourPlayerAwaitingDefenseState<PlayerId>
  | FourPlayerFinishedState<PlayerId>;
export type FourPlayerAction<PlayerId extends string = string> =
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

function fail(code: FourPlayerErrorCode, message: string): never {
  throw new FourPlayerEngineError(code, message);
}
function nextSeat<PlayerId extends string>(
  players: StateData<PlayerId>['players'],
  player: PlayerId,
  distance = 1,
): PlayerId {
  const index = players.indexOf(player);
  if (index < 0) fail('INVALID_INITIAL_STATE', 'Player is not seated');
  return players[(index + distance) % 4]!;
}
function roles<PlayerId extends string>(
  players: StateData<PlayerId>['players'],
  roundAttacker: PlayerId,
) {
  const defender = nextSeat(players, roundAttacker);
  return {
    defender,
    observer: nextSeat(players, defender, 2),
    attackers: [roundAttacker, nextSeat(players, roundAttacker, 2)] as const,
  };
}
function allCards<PlayerId extends string>(state: StateData<PlayerId>): Card[] {
  return [
    ...state.players.flatMap((p) => [...(state.hands.get(p) ?? [])]),
    ...state.stock,
    ...state.discard,
    ...state.table.flatMap(({ attack, defense }) =>
      defense ? [attack, defense] : [attack],
    ),
  ];
}
export function assertFourPlayerInvariant<PlayerId extends string>(
  state: StateData<PlayerId>,
): void {
  const expected = new Set(createStandardDeck().map((card) => card.id));
  const seen = new Set<string>();
  for (const value of allCards(state)) {
    const parsed = cardSchema.safeParse(value);
    if (
      !parsed.success ||
      !expected.has(parsed.data.id) ||
      seen.has(parsed.data.id)
    )
      fail(
        'INVALID_INITIAL_STATE',
        'Cards must be one complete unique standard deck',
      );
    seen.add(parsed.data.id);
  }
  if (seen.size !== 54)
    fail(
      'INVALID_INITIAL_STATE',
      'Cards must be one complete unique standard deck',
    );
  if (state.bottomCard?.id !== state.stock.at(-1)?.id)
    fail('INVALID_INITIAL_STATE', 'Bottom card must match stock bottom');
  const expectedRoles = roles(state.players, state.roundAttacker);
  if (
    state.defender !== expectedRoles.defender ||
    state.observer !== expectedRoles.observer ||
    state.attackers[0] !== expectedRoles.attackers[0] ||
    state.attackers[1] !== expectedRoles.attackers[1] ||
    !state.attackers.includes(state.attackCursor)
  )
    fail('INVALID_INITIAL_STATE', 'Round roles are inconsistent');
}
function teamOf<PlayerId extends string>(
  state: StateData<PlayerId>,
  player: PlayerId,
): FourPlayerTeam<PlayerId> {
  return state.teams[(state.players.indexOf(player) % 2) as 0 | 1];
}
function terminalResult<PlayerId extends string>(
  state: StateData<PlayerId>,
): FourPlayerResult<PlayerId> | null {
  // Stable seat order is provisional for simultaneous joker-only hands; task 10 must review it.
  for (const player of state.players) {
    const hand = state.hands.get(player)!;
    if (hand.length > 0 && hand.every((card) => card.kind === 'joker')) {
      const losingTeam = teamOf(state, player);
      const winningTeam = state.teams[losingTeam.id === 0 ? 1 : 0];
      return {
        winningTeam,
        losingTeam,
        triggerPlayer: player,
        reason: 'stuck-with-jokers',
      };
    }
  }
  for (const player of state.players)
    if (state.hands.get(player)!.length === 0) {
      const winningTeam = teamOf(state, player);
      const losingTeam = state.teams[winningTeam.id === 0 ? 1 : 0];
      return {
        winningTeam,
        losingTeam,
        triggerPlayer: player,
        reason: 'emptied-hand',
      };
    }
  return null;
}
function finalize<PlayerId extends string>(
  state:
    | FourPlayerAwaitingAttackState<PlayerId>
    | FourPlayerAwaitingDefenseState<PlayerId>,
): FourPlayerState<PlayerId> {
  assertFourPlayerInvariant(state);
  const result = terminalResult(state);
  return result ? { ...state, phase: 'finished', actor: null, result } : state;
}
export function createFourPlayerState<PlayerId extends string>(
  deal: InitialDeal<PlayerId>,
  players: readonly PlayerId[],
): FourPlayerState<PlayerId> {
  if (players.length !== 4 || new Set(players).size !== 4)
    fail('INVALID_INITIAL_STATE', 'Four distinct players are required');
  const seats = players as unknown as StateData<PlayerId>['players'];
  if (!players.includes(deal.firstDefender) || deal.hands.size !== 4)
    fail('INVALID_INITIAL_STATE', 'Initial deal players do not match');
  for (const player of players)
    if (!deal.hands.has(player) || deal.hands.get(player)!.length !== 8)
      fail(
        'INVALID_INITIAL_STATE',
        'Each player must have exactly eight cards',
      );
  if (
    deal.indicator.kind !== 'standard' ||
    deal.indicator.suit !== deal.trumpSuit ||
    deal.stock.at(-1)?.id !== deal.indicator.id
  )
    fail(
      'INVALID_INITIAL_STATE',
      'Indicator and stock bottom are inconsistent',
    );
  const roundAttacker = nextSeat(seats, deal.firstDefender, 3);
  const roundRoles = roles(seats, roundAttacker);
  const teams = [
    { id: 0, members: [seats[0], seats[2]] },
    { id: 1, members: [seats[1], seats[3]] },
  ] as const;
  return finalize({
    phase: 'awaiting-attack',
    players: seats,
    teams,
    hands: new Map(players.map((p) => [p, [...deal.hands.get(p)!]])),
    stock: [...deal.stock],
    discard: [],
    trumpSuit: deal.trumpSuit,
    bottomCard: deal.stock.at(-1) ?? null,
    roundAttacker,
    ...roundRoles,
    attackCursor: roundAttacker,
    actor: roundAttacker,
    table: [],
    leadRanks: new Set(),
    attackCount: 0,
    roundAttackLimit: deal.hands.get(deal.firstDefender)!.length,
    consecutivePasses: 0,
    indicatorExchanged: false,
    version: 0,
    result: null,
  });
}
function removeCard<PlayerId extends string>(
  state: StateData<PlayerId>,
  player: PlayerId,
  cardId: CardId,
) {
  const hand = state.hands.get(player) ?? [];
  const index = hand.findIndex((card) => card.id === cardId);
  if (index < 0) fail('CARD_NOT_IN_HAND', 'Card is not in the player hand');
  const nextHand = [...hand];
  const [card] = nextHand.splice(index, 1);
  return { hands: new Map(state.hands).set(player, nextHand), card: card! };
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
  state: StateData<PlayerId>,
  hands: ReadonlyMap<PlayerId, readonly Card[]>,
) {
  const nextHands = new Map(hands);
  const stock = [...state.stock];
  const start = state.players.indexOf(state.roundAttacker);
  for (let offset = 0; offset < 4; offset += 1) {
    const player = state.players[(start + offset) % 4]!;
    const hand = [...nextHands.get(player)!];
    while (hand.length < 8 && stock.length) hand.push(stock.shift()!);
    nextHands.set(player, hand);
  }
  return { hands: nextHands, stock };
}
function settle<PlayerId extends string>(
  state:
    | FourPlayerAwaitingAttackState<PlayerId>
    | FourPlayerAwaitingDefenseState<PlayerId>,
  kind: 'defended' | 'taken',
): FourPlayerState<PlayerId> {
  const tableCards = state.table.flatMap(({ attack, defense }) =>
    defense ? [attack, defense] : [attack],
  );
  const hands = new Map(state.hands);
  let discard = [...state.discard];
  if (kind === 'taken')
    hands.set(state.defender, [...hands.get(state.defender)!, ...tableCards]);
  else discard = [...discard, ...tableCards];
  const replenished = replenish(state, hands);
  const roundAttacker =
    kind === 'defended'
      ? state.defender
      : nextSeat(state.players, state.defender);
  const roundRoles = roles(state.players, roundAttacker);
  return finalize({
    ...state,
    phase: 'awaiting-attack',
    hands: replenished.hands,
    stock: replenished.stock,
    discard,
    bottomCard: replenished.stock.at(-1) ?? null,
    roundAttacker,
    ...roundRoles,
    attackCursor: roundAttacker,
    actor: roundAttacker,
    table: [],
    leadRanks: new Set(),
    attackCount: 0,
    roundAttackLimit: replenished.hands.get(roundRoles.defender)!.length,
    consecutivePasses: 0,
    version: state.version + 1,
    result: null,
  });
}
function exchange<PlayerId extends string>(
  state:
    | FourPlayerAwaitingAttackState<PlayerId>
    | FourPlayerAwaitingDefenseState<PlayerId>,
  player: PlayerId,
): FourPlayerState<PlayerId> {
  if (!state.players.includes(player)) fail('WRONG_ACTOR', 'Unknown player');
  if (state.indicatorExchanged)
    fail('INDICATOR_ALREADY_EXCHANGED', 'Indicator was already exchanged');
  if (!state.stock.length) fail('STOCK_EMPTY', 'Stock has no bottom card');
  const trumpTwo = state.hands
    .get(player)!
    .find(
      (card) =>
        card.kind === 'standard' &&
        card.suit === state.trumpSuit &&
        card.rank === '2',
    );
  if (!trumpTwo)
    fail('TRUMP_TWO_UNAVAILABLE', 'Player does not hold trump two');
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
export function applyFourPlayerAction<PlayerId extends string>(
  state: FourPlayerState<PlayerId>,
  action: FourPlayerAction<PlayerId>,
): FourPlayerState<PlayerId> {
  if (state.phase === 'finished')
    fail('GAME_FINISHED', 'The game is already finished');
  const active = state;
  if (action.type === 'exchange-trump-two')
    return exchange(active, action.playerId);
  if (action.type === 'take') {
    if (action.playerId !== active.defender)
      fail('WRONG_ACTOR', 'Only defender can take');
    if (!active.table.length) fail('WRONG_PHASE', 'Table is empty');
    return settle(active, 'taken');
  }
  if (
    !active.players.includes(action.playerId) ||
    active.actor !== action.playerId
  )
    fail('WRONG_ACTOR', 'It is not this player’s turn');
  if (action.type === 'attack') {
    if (active.phase !== 'awaiting-attack')
      fail('WRONG_PHASE', 'An attack is not expected');
    const handCard = active.hands
      .get(action.playerId)!
      .find((card) => card.id === action.cardId);
    if (!handCard) fail('CARD_NOT_IN_HAND', 'Card is not in hand');
    if (handCard.kind === 'joker')
      fail('JOKER_CANNOT_ATTACK', 'Jokers cannot attack');
    if (active.table.length && !active.leadRanks.has(handCard.rank))
      fail('RANK_NOT_ON_TABLE', 'Rank has not appeared');
    if (active.attackCount + 1 > active.roundAttackLimit)
      fail('ATTACK_LIMIT_REACHED', 'Fixed round limit reached');
    const removed = removeCard(active, action.playerId, action.cardId);
    return finalize({
      ...active,
      phase: 'awaiting-defense',
      hands: removed.hands,
      actor: active.defender,
      table: [...active.table, { attack: removed.card }],
      leadRanks: addRank(active.leadRanks, removed.card),
      attackCount: active.attackCount + 1,
      consecutivePasses: 0,
      version: active.version + 1,
      result: null,
    });
  }
  if (action.type === 'pass') {
    if (active.phase !== 'awaiting-attack')
      fail('WRONG_PHASE', 'Passing is not expected');
    if (active.table.length === 0)
      fail('WRONG_PHASE', 'The primary attacker must open the round');
    if (active.consecutivePasses + 1 === 2) return settle(active, 'defended');
    const cursor = active.attackers.find((p) => p !== active.attackCursor)!;
    return finalize({
      ...active,
      attackCursor: cursor,
      actor: cursor,
      consecutivePasses: active.consecutivePasses + 1,
      version: active.version + 1,
      result: null,
    });
  }
  if (active.phase !== 'awaiting-defense')
    fail('WRONG_PHASE', 'A defense is not expected');
  const unresolved = active.table.at(-1)!;
  const defendingCard = active.hands
    .get(action.playerId)!
    .find((card) => card.id === action.cardId);
  if (!defendingCard) fail('CARD_NOT_IN_HAND', 'Card is not in hand');
  if (compareCards(defendingCard, unresolved.attack, active.trumpSuit) !== 1)
    fail('CARD_CANNOT_BEAT_ATTACK', 'Defense card does not beat attack');
  const removed = removeCard(active, action.playerId, action.cardId);
  const table = active.table.map((pair, index) =>
    index === active.table.length - 1
      ? { ...pair, defense: removed.card }
      : pair,
  );
  const cursor = active.attackers.find((p) => p !== active.attackCursor)!;
  return finalize({
    ...active,
    phase: 'awaiting-attack',
    hands: removed.hands,
    actor: cursor,
    attackCursor: cursor,
    table,
    leadRanks: addRank(active.leadRanks, removed.card),
    version: active.version + 1,
    result: null,
  });
}
