import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from './logger.js';

afterEach(() => vi.restoreAllMocks());

describe('structured logging', () => {
  it('redacts secrets and credentials in URLs', () => {
    const output = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    log('error', 'test', {
      reconnectToken: 'private-token',
      databaseUrl: 'postgresql://user:password@db.example/8cards',
      error: new Error('failed postgresql://user:password@db.example/8cards'),
    });
    const entry = output.mock.calls[0]?.[0] as string;
    expect(entry).not.toContain('private-token');
    expect(entry).not.toContain('password');
    expect(entry).toContain('[REDACTED]');
  });
});
