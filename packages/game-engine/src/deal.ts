import { cardSchema, type Card, type Suit } from '@8cards/shared';

import { createStandardDeck } from './cards.js';
import { randomIndex, shuffleCards, type RandomSource } from './random.js';

export interface IndicatorSelection {
  readonly card: Card & { readonly kind: 'standard' };
  readonly index: number;
}

export interface InitialDeal<PlayerId extends string = string> {
  readonly hands: ReadonlyMap<PlayerId, readonly Card[]>;
  readonly stock: readonly Card[];
  readonly indicator: Card & { readonly kind: 'standard' };
  readonly trumpSuit: Suit;
  readonly firstDefender: PlayerId;
  readonly indicatorOriginalIndex: number;
  readonly drawOrder: readonly PlayerId[];
}

function assertPlayers<PlayerId extends string>(
  players: readonly PlayerId[],
): void {
  if (players.length < 2 || players.length > 4) {
    throw new RangeError('Initial deal requires 2, 3, or 4 players');
  }
  if (new Set(players).size !== players.length) {
    throw new Error('Player identifiers must be unique');
  }
}

function assertStandardDeck(deck: readonly Card[]): void {
  const expected = createStandardDeck();
  if (deck.length !== expected.length)
    throw new Error('Deck must contain exactly 54 cards');

  const expectedIds = new Set(expected.map((card) => card.id));
  const actualIds = new Set<string>();
  for (const value of deck) {
    const card = cardSchema.parse(value);
    if (!expectedIds.has(card.id) || actualIds.has(card.id)) {
      throw new Error('Deck must contain each standard card exactly once');
    }
    actualIds.add(card.id);
  }
}

export function selectIndicator(
  shuffledDeck: readonly Card[],
  playerCount: number,
  random: RandomSource,
): IndicatorSelection {
  if (
    !Number.isSafeInteger(playerCount) ||
    playerCount < 2 ||
    playerCount > 4
  ) {
    throw new RangeError('Indicator selection requires 2, 3, or 4 players');
  }

  const guaranteedDrawCount = playerCount * 8;
  if (shuffledDeck.length < guaranteedDrawCount) {
    throw new Error('Deck is too short for the initial draw');
  }

  const remainingIndices = Array.from(
    { length: guaranteedDrawCount },
    (_, index) => index,
  );
  while (remainingIndices.length > 0) {
    const candidateListIndex = randomIndex(remainingIndices.length, random);
    const [deckIndex] = remainingIndices.splice(candidateListIndex, 1);
    const card = shuffledDeck[deckIndex!];
    if (card?.kind === 'standard') return { card, index: deckIndex! };
  }

  throw new Error('Initial draw range does not contain a non-joker indicator');
}

export function dealInitialHands<PlayerId extends string>(
  shuffledDeck: readonly Card[],
  players: readonly PlayerId[],
  random: RandomSource,
): InitialDeal<PlayerId> {
  assertPlayers(players);
  assertStandardDeck(shuffledDeck);
  const selection = selectIndicator(shuffledDeck, players.length, random);
  const drawPile = [...shuffledDeck];
  const hands = new Map(players.map((player) => [player, [] as Card[]]));
  const drawOrder: PlayerId[] = [];
  let currentPlayerIndex = 0;
  let firstDefender: PlayerId | undefined;

  while ([...hands.values()].some((hand) => hand.length < 8)) {
    const player = players[currentPlayerIndex]!;
    const card = drawPile.shift();
    if (!card) throw new Error('Deck was exhausted during the initial draw');

    if (card.id === selection.card.id) {
      firstDefender = player;
      const replacement = drawPile.shift();
      if (!replacement)
        throw new Error('Deck cannot provide the indicator replacement card');
      hands.get(player)!.push(replacement);
      drawOrder.push(player);
    } else {
      hands.get(player)!.push(card);
      drawOrder.push(player);
    }
    currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
  }

  if (!firstDefender)
    throw new Error(
      'Selected indicator was not reached during the initial draw',
    );

  return {
    hands,
    stock: [...drawPile, selection.card],
    indicator: selection.card,
    trumpSuit: selection.card.suit,
    firstDefender,
    indicatorOriginalIndex: selection.index,
    drawOrder,
  };
}

export function createInitialDeal<PlayerId extends string>(
  players: readonly PlayerId[],
  random: RandomSource,
): InitialDeal<PlayerId> {
  return dealInitialHands(
    shuffleCards(createStandardDeck(), random),
    players,
    random,
  );
}
