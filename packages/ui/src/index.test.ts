import { expect, it } from 'vitest';

import { packageName } from './index.js';

it('exposes the UI package entry', () => {
  expect(packageName).toBe('@8cards/ui');
});
