import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { PlayerId, RoomSeries } from '@8cards/shared';
import { REACTIONS, QUICK_PHRASES } from './experience.js';
import { ReactionIcon } from './reaction-icon.js';
import { presentationProgress } from './round-presentation.js';

const a = 'A' as PlayerId;
const b = 'B' as PlayerId;
const series = {
  presentation: {
    id: '1-3',
    kind: 'initial',
    startsAt: new Date(0).toISOString(),
    dealsAt: new Date(500).toISOString(),
    readyAt: new Date(1200).toISOString(),
    stepMs: 100,
    stockBefore: 54,
    beforeCounts: [
      { playerId: a, count: 0 },
      { playerId: b, count: 0 },
    ],
    recipients: [a, b, a, b],
  },
} as RoomSeries;

describe('task 23 presentation and controlled graphics', () => {
  it('advances one card at each authoritative boundary and converges on late recovery', () => {
    expect(presentationProgress(series, 499)?.completed).toBe(0);
    expect(presentationProgress(series, 599)?.completed).toBe(0);
    expect(presentationProgress(series, 600)?.count(a)).toBe(1);
    expect(presentationProgress(series, 700)?.count(b)).toBe(1);
    expect(presentationProgress(series, 899)?.stock).toBe(51);
    expect(presentationProgress(series, 900)?.count(a)).toBe(2);
    expect(presentationProgress(series, 1199)?.completed).toBe(4);
    expect(presentationProgress(series, 1200)).toBeUndefined();
    expect(presentationProgress(series, 99000)).toBeUndefined();
    expect(presentationProgress(undefined, 0)).toBeUndefined();
  });
  it('retains every per-card recipient for same-player refills and an exhausted stock', () => {
    const refill = {
      ...series,
      presentation: {
        ...series.presentation!,
        stockBefore: 3,
        recipients: [a, a, b],
        beforeCounts: [
          { playerId: a, count: 6 },
          { playerId: b, count: 7 },
        ],
      },
    };
    expect(presentationProgress(refill, 700)?.count(a)).toBe(8);
    expect(presentationProgress(refill, 800)?.stock).toBe(0);
    expect(presentationProgress(refill, 800)?.count(b)).toBe(8);
    expect(JSON.stringify(refill.presentation)).not.toContain('cardId');
  });
  it('provides seven different explicit SVG drawings without font or external resources', () => {
    const graphics = REACTIONS.map((id) =>
      renderToStaticMarkup(createElement(ReactionIcon, { id })),
    );
    expect(new Set(graphics).size).toBe(7);
    for (const graphic of graphics) {
      expect(graphic).toContain('<svg');
      expect(graphic).toMatch(/<(path|ellipse)/);
      expect(graphic).toContain('width="40"');
      expect(graphic).not.toMatch(/https?:|<script|<image/);
    }
  });
  it('keeps all five user phrases literal in the existing text-chat path', () => {
    for (const phrase of [
      '豪到你了吗',
      '惊天大孙伯',
      '这猪÷',
      '野猪',
      '我日野猪',
    ])
      expect(QUICK_PHRASES).toContain(phrase);
  });
});
