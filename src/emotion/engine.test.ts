import { describe, it, expect } from 'vitest';
import { PrimaryEmotion, OPPOSITION_PAIRS, COMPOUND_EMOTIONS, SECONDARY_COMPOUNDS } from './types.js';
import {
  getOpposite,
  getDominant,
  getIntensityLabel,
  detectCompounds,
  getInertiaFactor,
  stimulate,
  decay,
  updateMood,
  createDefaultState
} from './engine.js';

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<Record<PrimaryEmotion, number>> = {}) {
  const base = createDefaultState();
  for (const [k, v] of Object.entries(overrides)) {
    base.emotions[k as PrimaryEmotion] = v;
  }
  return base;
}

// ─── getOpposite ────────────────────────────────────────────────────────────

describe('getOpposite', () => {
  it('returns correct opposition pairs', () => {
    expect(getOpposite(PrimaryEmotion.JOY)).toBe(PrimaryEmotion.SADNESS);
    expect(getOpposite(PrimaryEmotion.SADNESS)).toBe(PrimaryEmotion.JOY);
    expect(getOpposite(PrimaryEmotion.TRUST)).toBe(PrimaryEmotion.DISGUST);
    expect(getOpposite(PrimaryEmotion.FEAR)).toBe(PrimaryEmotion.ANGER);
    expect(getOpposite(PrimaryEmotion.SURPRISE)).toBe(PrimaryEmotion.ANTICIPATION);
  });

  it('covers all 4 opposition pairs bidirectionally', () => {
    for (const [a, b] of OPPOSITION_PAIRS) {
      expect(getOpposite(a)).toBe(b);
      expect(getOpposite(b)).toBe(a);
    }
  });
});

// ─── getDominant ────────────────────────────────────────────────────────────

describe('getDominant', () => {
  it('returns the emotion with the highest value', () => {
    const state = makeState({ [PrimaryEmotion.FEAR]: 0.9 });
    expect(getDominant(state.emotions)).toBe(PrimaryEmotion.FEAR);
  });

  it('returns anticipation for default state (highest at 0.30)', () => {
    const state = createDefaultState();
    expect(getDominant(state.emotions)).toBe(PrimaryEmotion.ANTICIPATION);
  });

  it('picks the first max when tied', () => {
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.5,
      [PrimaryEmotion.TRUST]: 0.5,
    });
    const dom = getDominant(state.emotions);
    // Both are 0.5, either is acceptable (implementation picks first found)
    expect([PrimaryEmotion.JOY, PrimaryEmotion.TRUST]).toContain(dom);
  });
});

// ─── getIntensityLabel ──────────────────────────────────────────────────────

describe('getIntensityLabel', () => {
  it('returns mild tier for low values', () => {
    expect(getIntensityLabel(PrimaryEmotion.JOY, 0.1)).toBe('serenity');
    expect(getIntensityLabel(PrimaryEmotion.FEAR, 0.2)).toBe('apprehension');
    expect(getIntensityLabel(PrimaryEmotion.ANGER, 0.33)).toBe('annoyance');
  });

  it('returns moderate tier for mid values', () => {
    expect(getIntensityLabel(PrimaryEmotion.JOY, 0.5)).toBe('joy');
    expect(getIntensityLabel(PrimaryEmotion.TRUST, 0.66)).toBe('trust');
  });

  it('returns intense tier for high values', () => {
    expect(getIntensityLabel(PrimaryEmotion.JOY, 0.9)).toBe('ecstasy');
    expect(getIntensityLabel(PrimaryEmotion.FEAR, 1.0)).toBe('terror');
    expect(getIntensityLabel(PrimaryEmotion.ANGER, 0.67)).toBe('rage');
  });

  it('covers all 8 emotions at all 3 tiers', () => {
    for (const emotion of Object.values(PrimaryEmotion)) {
      const mild = getIntensityLabel(emotion, 0.1);
      const moderate = getIntensityLabel(emotion, 0.5);
      const intense = getIntensityLabel(emotion, 0.9);
      expect(mild).toBeTruthy();
      expect(moderate).toBeTruthy();
      expect(intense).toBeTruthy();
      // All three should be different labels
      expect(new Set([mild, moderate, intense]).size).toBe(3);
    }
  });
});

// ─── detectCompounds ────────────────────────────────────────────────────────

describe('detectCompounds', () => {
  it('detects Love (Joy + Trust both high)', () => {
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.6,
      [PrimaryEmotion.TRUST]: 0.6,
    });
    expect(detectCompounds(state.emotions)).toContain('Love');
  });

  it('detects Anxiety (Anticipation + Fear)', () => {
    const state = makeState({
      [PrimaryEmotion.ANTICIPATION]: 0.5,
      [PrimaryEmotion.FEAR]: 0.5,
    });
    expect(detectCompounds(state.emotions)).toContain('Anxiety');
  });

  it('uses geometric mean — one high + one moderate can trigger', () => {
    // sqrt(0.6 * 0.2) = sqrt(0.12) = 0.346 > 0.3 threshold
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.6,
      [PrimaryEmotion.TRUST]: 0.2,
    });
    expect(detectCompounds(state.emotions)).toContain('Love');
  });

  it('does NOT trigger when geometric mean is below threshold', () => {
    // sqrt(0.2 * 0.2) = 0.2 < 0.3 threshold
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.2,
      [PrimaryEmotion.TRUST]: 0.2,
    });
    expect(detectCompounds(state.emotions)).not.toContain('Love');
  });

  it('returns empty array when all emotions are at baseline', () => {
    const state = createDefaultState();
    // Default baseline is 0.15, sqrt(0.15*0.15) = 0.15 < 0.3
    expect(detectCompounds(state.emotions)).toEqual([]);
  });

  it('can detect multiple compounds simultaneously', () => {
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.7,
      [PrimaryEmotion.TRUST]: 0.7,
      [PrimaryEmotion.ANTICIPATION]: 0.7,
    });
    const compounds = detectCompounds(state.emotions);
    expect(compounds).toContain('Love');       // Joy + Trust
    expect(compounds).toContain('Optimism');   // Anticipation + Joy
    expect(compounds).toContain('Hope');       // Anticipation + Trust
  });
});

// ─── getInertiaFactor ───────────────────────────────────────────────────────

describe('getInertiaFactor', () => {
  it('returns 1.0 (no dampening) for short streaks', () => {
    expect(getInertiaFactor(0)).toBe(1.0);
    expect(getInertiaFactor(1)).toBe(1.0);
    expect(getInertiaFactor(2)).toBe(1.0);
  });

  it('returns increasing dampening for moderate streaks', () => {
    expect(getInertiaFactor(3)).toBe(0.8);
    expect(getInertiaFactor(4)).toBe(0.8);
    expect(getInertiaFactor(5)).toBe(0.7);
    expect(getInertiaFactor(6)).toBe(0.7);
    expect(getInertiaFactor(7)).toBe(0.6);
    expect(getInertiaFactor(8)).toBe(0.6);
  });

  it('relaxes dampening for long streaks (system should recover)', () => {
    expect(getInertiaFactor(9)).toBe(0.75);
    expect(getInertiaFactor(12)).toBe(0.75);
    expect(getInertiaFactor(13)).toBe(0.9);
    expect(getInertiaFactor(100)).toBe(0.9);
  });
});

// ─── stimulate ──────────────────────────────────────────────────────────────

describe('stimulate', () => {
  it('increases target emotion', () => {
    const state = createDefaultState();
    const result = stimulate(state, [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.3,
      source: 'test stimulus'
    }]);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeGreaterThan(state.emotions[PrimaryEmotion.JOY]);
  });

  it('suppresses opposing emotion by 50% of intensity', () => {
    const state = makeState({
      [PrimaryEmotion.SADNESS]: 0.5,
    });
    const result = stimulate(state, [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.4,
      source: 'test'
    }]);
    // Sadness should decrease by 0.4 * 0.5 = 0.2
    expect(result.emotions[PrimaryEmotion.SADNESS]).toBeCloseTo(0.3, 5);
  });

  it('clamps emotions to [0, 1]', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.9 });
    const result = stimulate(state, [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.5,
      source: 'test'
    }]);
    expect(result.emotions[PrimaryEmotion.JOY]).toBe(1.0);

    const state2 = makeState({ [PrimaryEmotion.SADNESS]: 0.1 });
    const result2 = stimulate(state2, [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.5,
      source: 'test'
    }]);
    // Sadness suppressed by 0.25 from 0.1 → clamped at 0
    expect(result2.emotions[PrimaryEmotion.SADNESS]).toBe(0.0);
  });

  it('applies inertia dampening to streak-opposing stimuli', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.5, [PrimaryEmotion.SADNESS]: 0.3 });

    // Without inertia
    const noInertia = stimulate(state, [{
      emotion: PrimaryEmotion.SADNESS,
      intensity: 0.4,
      source: 'test'
    }]);

    // With inertia (streak on Joy, so Sadness stimulus is dampened)
    const withInertia = stimulate(state, [{
      emotion: PrimaryEmotion.SADNESS,
      intensity: 0.4,
      source: 'test'
    }], { streakEmotion: PrimaryEmotion.JOY, streakLength: 5 });

    // Inertia factor at streak 5 = 0.7, so effective intensity = 0.4 * 0.7 = 0.28
    expect(withInertia.emotions[PrimaryEmotion.SADNESS])
      .toBeLessThan(noInertia.emotions[PrimaryEmotion.SADNESS]);
  });

  it('updates dominant emotion and label after stimulation', () => {
    const state = createDefaultState();
    const result = stimulate(state, [{
      emotion: PrimaryEmotion.FEAR,
      intensity: 0.8,
      source: 'whale transfer'
    }]);
    expect(result.dominant).toBe(PrimaryEmotion.FEAR);
    expect(result.dominantLabel).toBe('terror'); // 0.15 + 0.8 = 0.95 → intense
  });

  it('builds trigger string from stimulus sources', () => {
    const state = createDefaultState();
    const result = stimulate(state, [
      { emotion: PrimaryEmotion.JOY, intensity: 0.1, source: 'chain activity' },
      { emotion: PrimaryEmotion.FEAR, intensity: 0.1, source: 'whale transfer' },
    ]);
    expect(result.trigger).toBe('chain activity; whale transfer');
  });

  it('preserves trigger when no stimuli provided', () => {
    const state = createDefaultState();
    const result = stimulate(state, []);
    expect(result.trigger).toBe(state.trigger);
  });
});

// ─── decay ──────────────────────────────────────────────────────────────────

describe('decay', () => {
  it('moves emotions toward baseline (0.15) over time', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.8 });
    const result = decay(state, 30); // 30 minutes elapsed
    expect(result.emotions[PrimaryEmotion.JOY]).toBeLessThan(0.8);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeGreaterThan(0.15);
  });

  it('raises emotions below baseline toward 0.15', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.0 });
    const result = decay(state, 30);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeGreaterThan(0.0);
  });

  it('leaves emotions at baseline unchanged', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.15 });
    const result = decay(state, 30);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeCloseTo(0.15, 5);
  });

  it('decays more with more time elapsed', () => {
    const state = makeState({ [PrimaryEmotion.FEAR]: 0.9 });
    const short = decay(state, 10);
    const long = decay(state, 60);
    // Longer decay moves closer to baseline
    expect(long.emotions[PrimaryEmotion.FEAR]).toBeLessThan(short.emotions[PrimaryEmotion.FEAR]);
  });

  it('zero minutes = no change', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.7 });
    const result = decay(state, 0);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeCloseTo(0.7, 5);
  });

  it('uses exponential decay formula correctly', () => {
    // Manual calculation: baseline + (current - baseline) * exp(-rate * minutes)
    // 0.15 + (0.8 - 0.15) * exp(-0.05 * 30) = 0.15 + 0.65 * exp(-1.5)
    const state = makeState({ [PrimaryEmotion.JOY]: 0.8 });
    const result = decay(state, 30);
    const expected = 0.15 + (0.8 - 0.15) * Math.exp(-0.05 * 30);
    expect(result.emotions[PrimaryEmotion.JOY]).toBeCloseTo(expected, 10);
  });
});

// ─── updateMood ─────────────────────────────────────────────────────────────

describe('updateMood', () => {
  it('moves mood toward current emotions', () => {
    const state = makeState({ [PrimaryEmotion.JOY]: 0.9 });
    state.mood[PrimaryEmotion.JOY] = 0.15; // mood still at baseline
    const result = updateMood(state);
    expect(result.mood[PrimaryEmotion.JOY]).toBeGreaterThan(0.15);
    // But should be slower than snapping directly to 0.9
    expect(result.mood[PrimaryEmotion.JOY]).toBeLessThan(0.9);
  });

  it('uses adaptive alpha — high volatility = faster mood shift', () => {
    // State with large emotion-mood divergence
    const volatile = makeState({ [PrimaryEmotion.JOY]: 1.0 });
    volatile.mood[PrimaryEmotion.JOY] = 0.0;

    // State with small divergence
    const calm = makeState({ [PrimaryEmotion.JOY]: 0.2 });
    calm.mood[PrimaryEmotion.JOY] = 0.15;

    const volResult = updateMood(volatile);
    const calmResult = updateMood(calm);

    // Volatile state should shift mood more aggressively
    const volShift = Math.abs(volResult.mood[PrimaryEmotion.JOY] - 0.0);
    const calmShift = Math.abs(calmResult.mood[PrimaryEmotion.JOY] - 0.15);
    expect(volShift).toBeGreaterThan(calmShift);
  });
});

// ─── createDefaultState ─────────────────────────────────────────────────────

describe('createDefaultState', () => {
  it('sets all emotions to baseline (0.15)', () => {
    const state = createDefaultState();
    for (const emotion of Object.values(PrimaryEmotion)) {
      if (emotion === PrimaryEmotion.ANTICIPATION) continue;
      expect(state.emotions[emotion]).toBe(0.15);
    }
  });

  it('sets anticipation slightly elevated (0.30)', () => {
    const state = createDefaultState();
    expect(state.emotions[PrimaryEmotion.ANTICIPATION]).toBe(0.30);
  });

  it('sets dominant to anticipation with interest label', () => {
    const state = createDefaultState();
    expect(state.dominant).toBe(PrimaryEmotion.ANTICIPATION);
    expect(state.dominantLabel).toBe('interest');
  });

  it('has empty compounds and genesis trigger', () => {
    const state = createDefaultState();
    expect(state.compounds).toEqual([]);
    expect(state.trigger).toContain('initial state');
  });

  it('initializes mood to match emotions', () => {
    const state = createDefaultState();
    for (const emotion of Object.values(PrimaryEmotion)) {
      expect(state.mood[emotion]).toBe(state.emotions[emotion]);
    }
  });

  it('has all 8 primary emotions', () => {
    const state = createDefaultState();
    expect(Object.keys(state.emotions)).toHaveLength(8);
  });
});
