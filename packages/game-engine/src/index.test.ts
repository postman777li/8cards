import { expect, it } from 'vitest';

import { packageName } from './index.js';

it('exposes the game engine package entry', () => {
  expect(packageName).toBe('@8cards/game-engine');
});
