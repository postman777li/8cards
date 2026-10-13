import { describe, expect, it } from 'vitest';

import { prototypeScenes, sceneFromHash } from './navigation.js';

describe('prototype navigation', () => {
  it('covers every required scene in order', () => {
    expect(prototypeScenes.map((scene) => scene.id)).toEqual([
      'home',
      'create',
      'waiting',
      'table',
      'result',
    ]);
  });

  it('falls back to home for an unknown hash', () => {
    expect(sceneFromHash('#/table')).toBe('table');
    expect(sceneFromHash('#/unknown')).toBe('home');
  });
});
