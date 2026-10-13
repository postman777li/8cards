import { z } from 'zod';

export const suitSchema = z.enum(['clubs', 'diamonds', 'hearts', 'spades']);
export const standardRankSchema = z.enum([
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
]);
export const jokerRankSchema = z.enum(['small-joker', 'big-joker']);
export const cardIdSchema = z
  .string()
  .regex(
    /^(clubs|diamonds|hearts|spades)-(2|3|4|5|6|7|8|9|10|J|Q|K|A)$|^(small|big)-joker$/,
  );
export const standardCardSchema = z.strictObject({
  id: cardIdSchema,
  kind: z.literal('standard'),
  suit: suitSchema,
  rank: standardRankSchema,
});
export const jokerCardSchema = z.strictObject({
  id: cardIdSchema,
  kind: z.literal('joker'),
  rank: jokerRankSchema,
});
export const cardSchema = z.discriminatedUnion('kind', [
  standardCardSchema,
  jokerCardSchema,
]);
export type Suit = z.infer<typeof suitSchema>;
export type StandardRank = z.infer<typeof standardRankSchema>;
export type JokerRank = z.infer<typeof jokerRankSchema>;
export type CardId = z.infer<typeof cardIdSchema>;
export type StandardCard = z.infer<typeof standardCardSchema>;
export type JokerCard = z.infer<typeof jokerCardSchema>;
export type Card = z.infer<typeof cardSchema>;
