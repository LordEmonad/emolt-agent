import { describe, it, expect } from 'vitest';
import type { StrategyWeights } from './types.js';
import { estimateMinAdjustments, computeLearningStats } from './learning-stats.js';
import { createDefaultWeights } from './weights.js';

// ─── estimateMinAdjustments ─────────────────────────────────────────────────

describe('estimateMinAdjustments', () => {
  it('returns 0 for weights within neutral band (±0.05 of 1.0)', () => {
    expect(estimateMinAdjustments(1.0, 200)).toBe(0);
    expect(estimateMinAdjustments(1.03, 200)).toBe(0);
    expect(estimateMinAdjustments(0.97, 200)).toBe(0);
  });

  it('returns 1+ for weights outside neutral band', () => {
    expect(estimateMinAdjustments(0.8, 200)).toBeGreaterThan(0);
    expect(estimateMinAdjustments(1.2, 200)).toBeGreaterThan(0);
  });

  it('requires more adjustments for weights farther from 1.0', () => {
    const adj80 = estimateMinAdjustments(0.8, 200);
    const adj50 = estimateMinAdjustments(0.5, 200);
    const adj33 = estimateMinAdjustments(0.33, 200);
    expect(adj50).toBeGreaterThan(adj80);
    expect(adj33).toBeGreaterThan(adj50);
  });

  it('requires more adjustments with more cycles (decay fights back harder)', () => {
    const short = estimateMinAdjustments(0.5, 50);
    const long = estimateMinAdjustments(0.5, 500);
    expect(long).toBeGreaterThanOrEqual(short);
  });

  it('handles amplified weights (above 1.0)', () => {
    const adj = estimateMinAdjustments(1.5, 200);
    expect(adj).toBeGreaterThan(0);
  });

  it('handles extreme dampening (near floor 0.3)', () => {
    const adj = estimateMinAdjustments(0.31, 300);
    expect(adj).toBeGreaterThan(0);
  });

  it('caps at 200 for unreachable targets', () => {
    // Weight of exactly 0.3 after many cycles is extremely hard
    const adj = estimateMinAdjustments(0.3, 1000);
    expect(adj).toBeLessThanOrEqual(200);
  });
});

// ─── computeLearningStats ───────────────────────────────────────────────────

describe('computeLearningStats', () => {
  it('categorizes weights as dampened, amplified, or neutral', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.33;      // dampened
    sw.weights.socialEngagement = 1.10;       // amplified
    sw.weights.gasPressure = 1.0;             // neutral

    const stats = computeLearningStats(sw, 279);
    expect(stats.dampenedCategories).toContain('chainActivityJoy');
    expect(stats.amplifiedCategories).toContain('socialEngagement');
    expect(stats.unchangedCategories).toContain('gasPressure');
  });

  it('sorts categories by deviation descending', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.33;  // deviation -0.67
    sw.weights.kuruOrderbook = 0.47;     // deviation -0.53
    sw.weights.gasPressure = 1.0;        // deviation 0

    const stats = computeLearningStats(sw, 279);
    expect(stats.categories[0].category).toBe('chainActivityJoy');
    expect(Math.abs(stats.categories[0].deviationFromDefault))
      .toBeGreaterThan(Math.abs(stats.categories[1].deviationFromDefault));
  });

  it('identifies most and least learned categories', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.33;  // most deviation
    // All others at 1.0 = least deviation (any of them is valid)

    const stats = computeLearningStats(sw, 279);
    expect(stats.mostLearned).toBe('chainActivityJoy');
    // leastLearned is any weight at 1.0 — just verify it's unchanged
    expect(stats.unchangedCategories).toContain(stats.leastLearned);
  });

  it('calculates total deviation across all categories', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.5;  // |deviation| = 0.5
    sw.weights.socialEngagement = 1.2;  // |deviation| = 0.2
    // Rest at 1.0 = 0 deviation each

    const stats = computeLearningStats(sw, 100);
    expect(stats.totalDeviation).toBeCloseTo(0.7, 5);
  });

  it('assigns learning intensity tiers correctly', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.33;   // extreme (|dev| = 0.67 > 0.55)
    sw.weights.whaleTransferFear = 0.42;  // strong (|dev| = 0.58 > 0.55) → extreme
    sw.weights.monPriceSentiment = 0.67;  // moderate (|dev| = 0.33)
    sw.weights.gasPressure = 1.0;         // none

    const stats = computeLearningStats(sw, 279);
    const getIntensity = (cat: string) => stats.categories.find(c => c.category === cat)?.learningIntensity;
    expect(getIntensity('chainActivityJoy')).toBe('extreme');
    expect(getIntensity('gasPressure')).toBe('none');
  });

  it('generates narratives for each category', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.5;

    const stats = computeLearningStats(sw, 200);
    const chainCat = stats.categories.find(c => c.category === 'chainActivityJoy');
    expect(chainCat?.narrative).toContain('chain activity');
    expect(chainCat?.narrative).toContain('reduced');
  });

  it('generates overall narrative', () => {
    const sw = createDefaultWeights();
    sw.weights.chainActivityJoy = 0.33;
    sw.weights.socialEngagement = 1.10;

    const stats = computeLearningStats(sw, 279);
    expect(stats.overallNarrative).toContain('279 cycles');
    expect(stats.overallNarrative).toContain('No human told it to do this');
  });

  it('handles all weights at default (no learning)', () => {
    const sw = createDefaultWeights();
    const stats = computeLearningStats(sw, 100);
    expect(stats.dampenedCategories).toHaveLength(0);
    expect(stats.amplifiedCategories).toHaveLength(0);
    expect(stats.unchangedCategories).toHaveLength(16);
    expect(stats.totalDeviation).toBe(0);
  });

  it('uses real EMOLT weights correctly', () => {
    // Actual weights from cycle 279
    const sw: StrategyWeights = {
      weights: {
        whaleTransferFear: 0.42,
        chainActivityJoy: 0.33,
        chainQuietSadness: 0.95,
        failedTxAnger: 0.95,
        nadFunExcitement: 0.33,
        emoPriceSentiment: 0.55,
        monPriceSentiment: 0.67,
        tvlSentiment: 1.0,
        socialEngagement: 1.09,
        selfPerformanceReaction: 0.92,
        ecosystemVolume: 0.94,
        gasPressure: 1.0,
        githubStarReaction: 1.0,
        feedJoy: 1.0,
        dexScreenerMarket: 0.65,
        kuruOrderbook: 0.47,
      },
      lastUpdated: Date.now(),
    };
    const stats = computeLearningStats(sw, 279);
    // Most learned should be chainActivityJoy or nadFunExcitement (both at 0.33)
    expect(['chainActivityJoy', 'nadFunExcitement']).toContain(stats.mostLearned);
    // Should have dampened categories
    expect(stats.dampenedCategories.length).toBeGreaterThan(5);
    // Social engagement should be amplified
    expect(stats.amplifiedCategories).toContain('socialEngagement');
    // Unchanged: tvl, gas, github, feed
    expect(stats.unchangedCategories).toContain('tvlSentiment');
    expect(stats.unchangedCategories).toContain('gasPressure');
  });
});
