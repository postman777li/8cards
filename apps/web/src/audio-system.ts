export type SoundCue =
  | 'select'
  | 'draw'
  | 'play'
  | 'beat'
  | 'collect'
  | 'pass'
  | 'your-turn'
  | 'countdown'
  | 'social'
  | 'win'
  | 'lose'
  | 'ranking';

export interface AudioPreferences {
  enabled: boolean;
  volume: number;
}

export const clampVolume = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.45));

export class GameAudio {
  #context: AudioContext | undefined;
  #preferences: AudioPreferences;
  #played = new Set<string>();

  constructor(preferences: AudioPreferences) {
    this.#preferences = {
      ...preferences,
      volume: clampVolume(preferences.volume),
    };
    try {
      const cached: unknown = JSON.parse(
        sessionStorage.getItem('8cards:audio:played') ?? '[]',
      );
      if (Array.isArray(cached))
        this.#played = new Set(
          cached
            .filter(
              (key): key is string =>
                typeof key === 'string' && key.length <= 300,
            )
            .slice(-128),
        );
    } catch {
      // Storage is optional, including in private browsing and server rendering.
    }
  }

  setPreferences(preferences: AudioPreferences) {
    this.#preferences = {
      ...preferences,
      volume: clampVolume(preferences.volume),
    };
  }

  async unlock() {
    if (!this.#preferences.enabled || typeof AudioContext === 'undefined')
      return;
    try {
      this.#context ??= new AudioContext();
      if (this.#context.state === 'suspended') await this.#context.resume();
    } catch {
      // Audio is optional and must never block the game.
    }
  }

  dispose() {
    const context = this.#context;
    this.#context = undefined;
    if (context) void context.close().catch(() => {});
    this.#played.clear();
  }

  play(cue: SoundCue, authorityKey?: string) {
    if (
      !this.#preferences.enabled ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    )
      return;
    const key = authorityKey ? `${cue}:${authorityKey}` : undefined;
    if (key && this.#played.has(key)) return;
    if (key) {
      this.#played.add(key);
      if (this.#played.size > 128)
        this.#played.delete(this.#played.values().next().value!);
      try {
        sessionStorage.setItem(
          '8cards:audio:played',
          JSON.stringify([...this.#played]),
        );
      } catch {
        /* Audio remains optional. */
      }
    }
    const context = this.#context;
    if (!context || context.state !== 'running') return;
    try {
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        this.#preferences.volume * 0.12,
        now + 0.008,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      gain.connect(context.destination);
      const oscillator = context.createOscillator();
      const frequencies: Record<SoundCue, number> = {
        select: 680,
        draw: 420,
        play: 180,
        beat: 240,
        collect: 130,
        pass: 330,
        'your-turn': 740,
        countdown: 520,
        social: 620,
        win: 880,
        lose: 190,
        ranking: 990,
      };
      oscillator.type =
        cue === 'play' || cue === 'collect' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequencies[cue], now);
      oscillator.frequency.exponentialRampToValueAtTime(
        frequencies[cue] * 0.78,
        now + 0.14,
      );
      oscillator.connect(gain);
      oscillator.start(now);
      oscillator.stop(now + 0.17);
    } catch {
      // Ignore unavailable or interrupted Web Audio nodes.
    }
  }
}
