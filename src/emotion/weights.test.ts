import { describe, it, expect } from 'vitest';
import { PrimaryEmotion } from './types.js';
import type { StrategyWeights, WeightAdjustment, EmotionStimulus } from './types.js';
import {
  createDefaultWeights,
  applyWeightAdjustments,
  decayWeights,
  applyStrategyWeights,
  ALL_WEIGHT_KEYS
} from './weights.js';

// ─── createDefaultWeights ───────────────────────────────────────────────────

describe('createDefaultWeights', () => {
  it('initializes all 16 weight keys to 1.0', () => {
    const sw = createDefaultWeights();
    for (const key of ALL_WEIGHT_KEYS) {
      expect(sw.weights[key]).toBe(1.0);
    }
  });

  it('has exactly 16 weight keys', () => {
    expect(ALL_WEIGHT_KEYS).toHaveLength(16);
  });

  it('has a lastUpdated timestamp', () => {
    const sw = createDefaultWeights();
    expect(sw.lastUpdated).toBeGreaterThan(0);
  });
});

// ─── applyWeightAdjustments ─────────────────────────────────────────────────

describe('applyWeightAdjustments', () => {
  it('increases weight by nudge (0.05)', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [{
      key: 'whaleTransferFear',
      direction: 'increase',
      magnitude: 'nudge',
      reason: 'test'
    }]);
    expect(sw.weights.whaleTransferFear).toBeCloseTo(1.05, 5);
  });

  it('increases weight by moderate (0.1)', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [{
      key: 'chainActivityJoy',
      direction: 'increase',
      magnitude: 'moderate',
      reason: 'test'
    }]);
    expect(sw.weights.chainActivityJoy).toBeCloseTo(1.1, 5);
  });

  it('increases weight by strong (0.2)', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [{
      key: 'socialEngagement',
      direction: 'increase',
      magnitude: 'strong',
      reason: 'test'
    }]);
    expect(sw.weights.socialEngagement).toBeCloseTo(1.2, 5);
  });

  it('decreases weight correctly', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [{
      key: 'gasPressure',
      direction: 'decrease',
      magnitude: 'moderate',
      reason: 'test'
    }]);
    expect(sw.weights.gasPressure).toBeCloseTo(0.9, 5);
  });

  it('defaults to moderate magnitude when unspecified', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [{
      key: 'tvlSentiment',
      direction: 'increase',
      reason: 'test'
    }]);
    expect(sw.weights.tvlSentiment).toBeCloseTo(1.1, 5);
  });

  it('resets weight to 1.0', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 0.5;
    applyWeightAdjustments(sw, [{
      key: 'whaleTransferFear',
      direction: 'reset',
      reason: 'test'
    }]);
    expect(sw.weights.whaleTransferFear).toBe(1.0);
  });

  it('clamps at ceiling (2.0)', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 1.95;
    applyWeightAdjustments(sw, [{
      key: 'chainActivityJoy',
      direction: 'increase',
      magnitude: 'strong', // +0.2 → 2.15 → clamped to 2.0
      reason: 'test'
    }]);
    expect(sw.weights.chainActivityJoy).toBe(2.0);
  });

  it('clamps at floor (0.3)', () => {
    const sw = createDefaultWeights();
    sw.weights.failedTxAnger = 0.35;
    applyWeightAdjustments(sw, [{
      key: 'failedTxAnger',
      direction: 'decrease',
      magnitude: 'strong', // -0.2 → 0.15 → clamped to 0.3
      reason: 'test'
    }]);
    expect(sw.weights.failedTxAnger).toBe(0.3);
  });

  it('ignores unknown weight keys', () => {
    const sw = createDefaultWeights();
    const before = { ...sw.weights };
    applyWeightAdjustments(sw, [{
      key: 'nonexistentKey' as any,
      direction: 'increase',
      reason: 'test'
    }]);
    expect(sw.weights).toEqual(before);
  });

  it('applies multiple adjustments in order', () => {
    const sw = createDefaultWeights();
    applyWeightAdjustments(sw, [
      { key: 'whaleTransferFear', direction: 'increase', magnitude: 'strong', reason: 'test' },
      { key: 'whaleTransferFear', direction: 'decrease', magnitude: 'nudge', reason: 'test' },
    ]);
    // 1.0 + 0.2 - 0.05 = 1.15
    expect(sw.weights.whaleTransferFear).toBeCloseTo(1.15, 5);
  });
});

// ─── decayWeights ───────────────────────────────────────────────────────────

describe('decayWeights', () => {
  it('moves weights toward 1.0', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 1.5;
    sw.weights.chainActivityJoy = 0.5;
    decayWeights(sw);
    expect(sw.weights.whaleTransferFear).toBeLessThan(1.5);
    expect(sw.weights.chainActivityJoy).toBeGreaterThan(0.5);
  });

  it('does not move weights already at 1.0', () => {
    const sw = createDefaultWeights();
    decayWeights(sw);
    for (const key of ALL_WEIGHT_KEYS) {
      expect(sw.weights[key]).toBe(1.0);
    }
  });

  it('uses correct decay formula: w + (1 - w) * 0.005', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 1.5;
    decayWeights(sw);
    // 1.5 + (1.0 - 1.5) * 0.005 = 1.5 - 0.0025 = 1.4975
    expect(sw.weights.whaleTransferFear).toBeCloseTo(1.4975, 5);
  });

  it('takes ~140 cycles to halve a deviation from 1.0', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 2.0; // deviation = 1.0
    for (let i = 0; i < 140; i++) {
      decayWeights(sw);
    }
    const deviation = Math.abs(sw.weights.whaleTransferFear - 1.0);
    // Should be roughly half the original deviation (0.5 ± tolerance)
    expect(deviation).toBeCloseTo(0.5, 0);
  });
});

// ─── applyStrategyWeights ───────────────────────────────────────────────────

describe('applyStrategyWeights', () => {
  it('multiplies stimulus intensity by its category weight', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 1.5;
    const stimuli: EmotionStimulus[] = [{
      emotion: PrimaryEmotion.FEAR,
      intensity: 0.4,
      source: 'whale',
      weightCategory: 'whaleTransferFear'
    }];
    const result = applyStrategyWeights(stimuli, sw);
    expect(result[0].intensity).toBeCloseTo(0.6, 5); // 0.4 * 1.5
  });

  it('leaves stimuli without weightCategory unchanged', () => {
    const sw = createDefaultWeights();
    sw.weights.whaleTransferFear = 2.0;
    const stimuli: EmotionStimulus[] = [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.5,
      source: 'test'
      // no weightCategory
    }];
    const result = applyStrategyWeights(stimuli, sw);
    expect(result[0].intensity).toBe(0.5);
  });

  it('defaults to 1.0 for unknown weight categories', () => {
    const sw = createDefaultWeights();
    const stimuli: EmotionStimulus[] = [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.5,
      source: 'test',
      weightCategory: 'nonexistent' as any
    }];
    const result = applyStrategyWeights(stimuli, sw);
    expect(result[0].intensity).toBe(0.5);
  });

  it('does not mutate original stimuli array', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 2.0;
    const stimuli: EmotionStimulus[] = [{
      emotion: PrimaryEmotion.JOY,
      intensity: 0.3,
      source: 'test',
      weightCategory: 'chainActivityJoy'
    }];
    const result = applyStrategyWeights(stimuli, sw);
    expect(stimuli[0].intensity).toBe(0.3); // original unchanged
    expect(result[0].intensity).toBeCloseTo(0.6, 5); // new copy weighted
  });
});
