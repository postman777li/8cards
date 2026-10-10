import { expect, it } from 'vitest';

import { packageName } from './index.js';

it('exposes the shared package entry', () => {
  expect(packageName).toBe('@8cards/shared');
});
