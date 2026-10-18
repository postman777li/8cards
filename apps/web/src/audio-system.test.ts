import { afterEach, expect, it, vi } from 'vitest';
import { GameAudio } from './audio-system.js';

afterEach(() => vi.unstubAllGlobals());

it('deduplicates public authority cues across a page reload and cleans up contexts', async () => {
  let cached: string | null = null;
  let starts = 0,
    closes = 0;
  vi.stubGlobal('sessionStorage', {
    getItem: () => cached,
    setItem: (_key: string, value: string) => {
      cached = value;
    },
  });
  class Context {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => {
      closes++;
    };
    createGain = () => ({
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    });
    createOscillator = () => ({
      type: 'sine',
      frequency: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
      start: () => {
        starts++;
      },
      stop: () => {},
    });
  }
  vi.stubGlobal('AudioContext', Context);
  const first = new GameAudio({ enabled: true, volume: 0.4 });
  await first.unlock();
  first.play('draw', 'game-A:1-3:5');
  first.play('draw', 'game-A:1-3:5');
  expect(starts).toBe(1);
  first.dispose();
  const reloaded = new GameAudio({ enabled: true, volume: 0.4 });
  await reloaded.unlock();
  reloaded.play('draw', 'game-A:1-3:5');
  expect(starts).toBe(1);
  reloaded.play('draw', 'game-A:1-3:6');
  reloaded.play('draw', 'game-B:1-3:5');
  expect(starts).toBe(3);
  reloaded.dispose();
  expect(closes).toBe(2);
});

it('bounds the tab cache and stores only explicit cue keys', () => {
  let cached = '[]';
  vi.stubGlobal('sessionStorage', {
    getItem: () => cached,
    setItem: (_key: string, value: string) => {
      cached = value;
    },
  });
  const audio = new GameAudio({ enabled: true, volume: 0.4 });
  for (let i = 0; i < 200; i++) audio.play('play', 'game-public:' + i);
  expect(JSON.parse(cached)).toHaveLength(128);
  expect(cached).not.toMatch(/hand|stock|reconnectToken/);
});

it('degrades safely when audio and storage are unavailable', async () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('disabled');
    },
    setItem: () => {
      throw new Error('disabled');
    },
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        throw new Error('unavailable');
      }
    },
  );
  const audio = new GameAudio({ enabled: true, volume: 0.4 });
  await expect(audio.unlock()).resolves.toBeUndefined();
  expect(() => audio.play('win', 'game:1')).not.toThrow();
  expect(() => audio.dispose()).not.toThrow();
});
