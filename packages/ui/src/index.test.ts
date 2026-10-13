import { expect, it } from 'vitest';

import { Button, packageName, PlayingCard } from './index.js';

it('exposes the UI package entry', () => {
  expect(packageName).toBe('@8cards/ui');
});

it('applies an explicit button variant and accessible card label', () => {
  const button = Button({ children: '创建房间', variant: 'secondary' });
  const card = PlayingCard({ rank: 'A', suit: 'heart', legal: true });

  expect(button.props.className).toContain('ui-button--secondary');
  expect(card.props['aria-label']).toBe('♥ A');
  expect(card.props.className).toContain('ui-card--legal');
});
