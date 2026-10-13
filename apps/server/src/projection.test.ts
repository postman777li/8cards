import type { PlayerId } from '@8cards/shared';
import { describe, expect, it } from 'vitest';

import { projectLoserIds, type AuthorityState } from './projection.js';

describe('multiplayer result projection', () => {
  it('publishes only the independent three-player joker loser id', () => {
    const authority = {
      mode: 3,
      state: {
        phase: 'finished',
        result: {
          outcome: 'loser',
          loser: 'p2',
          reason: 'stuck-with-jokers',
        },
      },
    } as unknown as AuthorityState;
    expect(projectLoserIds(authority)).toEqual(['p2' as PlayerId]);
  });

  it('publishes the server-authoritative four-player losing team', () => {
    const authority = {
      mode: 4,
      state: {
        phase: 'finished',
        result: {
          losingTeam: { id: 1, members: ['p1', 'p3'] },
        },
      },
    } as unknown as AuthorityState;
    expect(projectLoserIds(authority)).toEqual([
      'p1' as PlayerId,
      'p3' as PlayerId,
    ]);
  });

  it('does not add loser ids to unfinished or two-player states', () => {
    expect(
      projectLoserIds({
        mode: 3,
        state: { phase: 'awaiting-attack' },
      } as unknown as AuthorityState),
    ).toBeUndefined();
    expect(
      projectLoserIds({
        mode: 2,
        state: { phase: 'finished', result: {} },
      } as unknown as AuthorityState),
    ).toBeUndefined();
  });
});
