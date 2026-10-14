import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('production configuration', () => {
  it('requires PostgreSQL and an HTTPS public origin', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL',
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://user:secret@db.example/8cards?sslmode=require',
        PUBLIC_BASE_URL: 'http://cards.example',
      }),
    ).toThrow('HTTPS');
  });

  it('derives an exact trusted origin without exposing database credentials', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://user:secret@db.example/8cards?sslmode=require',
      PUBLIC_BASE_URL: 'https://cards.example',
    });
    expect(config.trustedOrigins).toEqual(new Set(['https://cards.example']));
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('keeps SQLite available for local development', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      nodeEnv: 'development',
      port: 3001,
    });
  });
});
