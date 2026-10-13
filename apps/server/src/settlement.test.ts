import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@8cards/shared';
import { settlementOutcome } from './settlement.js';

const id = (value: string) => value as PlayerId;

describe('authoritative settlement outcomes', () => {
  it('marks the non-winner as the loser in a two-player joker finish', () => {
    expect(settlementOutcome(2, id('p1'), new Set([id('p2')]), new Set())).toBe(
      'loss',
    );
  });
  it('does not invent winners for the two unaffected players in a three-player joker finish', () => {
    const losers = new Set([id('p1')]);
    expect(settlementOutcome(3, id('p1'), new Set(), losers)).toBe('loss');
    expect(settlementOutcome(3, id('p2'), new Set(), losers)).toBe(
      'unresolved',
    );
    expect(settlementOutcome(3, id('p3'), new Set(), losers)).toBe(
      'unresolved',
    );
  });
  it('marks both four-player team members as losses without identifying both as trigger players', () => {
    const winners = new Set([id('p0'), id('p2')]);
    const losers = new Set([id('p1'), id('p3')]);
    expect(
      [id('p0'), id('p1'), id('p2'), id('p3')].map((player) =>
        settlementOutcome(4, player, winners, losers),
      ),
    ).toEqual(['win', 'loss', 'win', 'loss']);
  });
});
