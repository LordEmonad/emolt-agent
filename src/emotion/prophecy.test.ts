import { describe, it, expect } from 'vitest';
import { PrimaryEmotion } from './types.js';
import type { EmotionStimulus } from './types.js';
import {
  createProphecySnapshot,
  evaluateProphecy,
  updateProphecyStats,
  getPendingEvaluations,
  formatProphecyForPrompt,
} from './prophecy.js';
import type { ProphecySnapshot, ProphecyStats, ProphecyEvaluation } from './prophecy.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<ProphecySnapshot> = {}): ProphecySnapshot {
  return {
    cycle: 100,
    timestamp: Date.now(),
    monPriceUsd: 0.025,
    emoPriceUsd: 0.0002,
    tvl: 250_000_000,
    txCountChange: 5,
    nadFunCreates: 10,
    dexVolume1h: 100_000,
    kuruSpreadPct: 1.5,
    gasPriceGwei: 100,
    activeCategories: [],
    evaluated: false,
    ...overrides,
  };
}

function makeStats(): ProphecyStats {
  return {
    totalEvaluated: 0,
    totalCorrect: 0,
    overallAccuracy: 0,
    categoryAccuracy: {},
    categoryEvaluated: {},
    categoryCorrect: {},
    recentEvaluations: [],
    lastUpdated: Date.now(),
  };
}

// ─── createProphecySnapshot ─────────────────────────────────────────────────

describe('createProphecySnapshot', () => {
  it('captures market data from input', () => {
    const snap = createProphecySnapshot({
      cycle: 42,
      monPriceUsd: 0.03,
      emoPriceUsd: 0.001,
      tvl: 300_000_000,
      txCountChange: 10,
      nadFunCreates: 5,
      dexVolume1h: 50_000,
      kuruSpreadPct: 2.0,
      gasPriceGwei: 80,
      stimuli: [],
    });
    expect(snap.cycle).toBe(42);
    expect(snap.monPriceUsd).toBe(0.03);
    expect(snap.tvl).toBe(300_000_000);
    expect(snap.evaluated).toBe(false);
  });

  it('extracts active categories from stimuli', () => {
    const stimuli: EmotionStimulus[] = [
      { emotion: PrimaryEmotion.FEAR, intensity: 0.6, source: 'whale', weightCategory: 'whaleTransferFear' },
      { emotion: PrimaryEmotion.JOY, intensity: 0.4, source: 'chain', weightCategory: 'chainActivityJoy' },
    ];
    const snap = createProphecySnapshot({
      cycle: 1, monPriceUsd: 0.02, emoPriceUsd: 0, tvl: 100, txCountChange: 0,
      nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0, gasPriceGwei: 0,
      stimuli,
    });
    expect(snap.activeCategories).toHaveLength(2);
    expect(snap.activeCategories[0].category).toBe('whaleTransferFear');
    expect(snap.activeCategories[0].direction).toBe('negative'); // fear = negative
    expect(snap.activeCategories[1].category).toBe('chainActivityJoy');
    expect(snap.activeCategories[1].direction).toBe('positive'); // joy = positive
  });

  it('filters out low-intensity stimuli (below 0.1)', () => {
    const stimuli: EmotionStimulus[] = [
      { emotion: PrimaryEmotion.JOY, intensity: 0.05, source: 'test', weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.FEAR, intensity: 0.3, source: 'test', weightCategory: 'whaleTransferFear' },
    ];
    const snap = createProphecySnapshot({
      cycle: 1, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0,
      nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0, gasPriceGwei: 0,
      stimuli,
    });
    expect(snap.activeCategories).toHaveLength(1);
    expect(snap.activeCategories[0].category).toBe('whaleTransferFear');
  });

  it('keeps only the strongest stimulus per category', () => {
    const stimuli: EmotionStimulus[] = [
      { emotion: PrimaryEmotion.JOY, intensity: 0.3, source: 'a', weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.TRUST, intensity: 0.7, source: 'b', weightCategory: 'chainActivityJoy' },
    ];
    const snap = createProphecySnapshot({
      cycle: 1, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0,
      nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0, gasPriceGwei: 0,
      stimuli,
    });
    expect(snap.activeCategories).toHaveLength(1);
    expect(snap.activeCategories[0].intensity).toBe(0.7);
  });

  it('skips stimuli without weightCategory', () => {
    const stimuli: EmotionStimulus[] = [
      { emotion: PrimaryEmotion.JOY, intensity: 0.5, source: 'test' },
    ];
    const snap = createProphecySnapshot({
      cycle: 1, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0,
      nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0, gasPriceGwei: 0,
      stimuli,
    });
    expect(snap.activeCategories).toHaveLength(0);
  });

  it('sorts active categories by intensity descending', () => {
    const stimuli: EmotionStimulus[] = [
      { emotion: PrimaryEmotion.JOY, intensity: 0.3, source: 'a', weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.FEAR, intensity: 0.8, source: 'b', weightCategory: 'whaleTransferFear' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.5, source: 'c', weightCategory: 'nadFunExcitement' },
    ];
    const snap = createProphecySnapshot({
      cycle: 1, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0,
      nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0, gasPriceGwei: 0,
      stimuli,
    });
    expect(snap.activeCategories[0].intensity).toBe(0.8);
    expect(snap.activeCategories[1].intensity).toBe(0.5);
    expect(snap.activeCategories[2].intensity).toBe(0.3);
  });
});

// ─── evaluateProphecy ───────────────────────────────────────────────────────

describe('evaluateProphecy', () => {
  it('evaluates whaleTransferFear: correct when price drops 2%+', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'whaleTransferFear', intensity: 0.5, direction: 'negative' }],
    });
    const current = { cycle: 148, monPriceUsd: 0.97, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates whaleTransferFear: incorrect when price holds', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'whaleTransferFear', intensity: 0.5, direction: 'negative' }],
    });
    const current = { cycle: 148, monPriceUsd: 1.01, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(false);
  });

  it('evaluates chainActivityJoy: correct when activity or TVL up', () => {
    const snap = makeSnapshot({
      tvl: 100,
      activeCategories: [{ category: 'chainActivityJoy', intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 110, txCountChange: 5, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates monPriceSentiment: correct when bullish signal and price rises', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'monPriceSentiment', intensity: 0.5, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 1.05, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
    expect(result.results[0].predicted).toContain('bullish');
  });

  it('evaluates monPriceSentiment: incorrect when bullish signal but price falls', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'monPriceSentiment', intensity: 0.5, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0.90, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(false);
  });

  it('evaluates monPriceSentiment: correct when bearish signal and price falls', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'monPriceSentiment', intensity: 0.5, direction: 'negative' }],
    });
    const current = { cycle: 148, monPriceUsd: 0.90, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
    expect(result.results[0].predicted).toContain('bearish');
  });

  it('evaluates emoPriceSentiment: returns false when no price data', () => {
    const snap = makeSnapshot({
      emoPriceUsd: 0,
      activeCategories: [{ category: 'emoPriceSentiment', intensity: 0.5, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(false);
    expect(result.results[0].predicted).toBe('no data');
  });

  it('evaluates tvlSentiment: correct when TVL holds within 2%', () => {
    const snap = makeSnapshot({
      tvl: 100,
      activeCategories: [{ category: 'tvlSentiment', intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 99, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates nadFunExcitement: correct when launches sustain 80%', () => {
    const snap = makeSnapshot({
      nadFunCreates: 10,
      activeCategories: [{ category: 'nadFunExcitement', intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 8, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates dexScreenerMarket: correct when volume holds 50%+', () => {
    const snap = makeSnapshot({
      dexVolume1h: 100_000,
      activeCategories: [{ category: 'dexScreenerMarket', intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 60_000, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates kuruOrderbook: correct when spread stays within 2x', () => {
    const snap = makeSnapshot({
      kuruSpreadPct: 1.0,
      activeCategories: [{ category: 'kuruOrderbook', intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 1.8 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('evaluates unknown categories with holistic check', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      activeCategories: [{ category: 'gasPressure' as any, intensity: 0.4, direction: 'positive' }],
    });
    const current = { cycle: 148, monPriceUsd: 1.10, emoPriceUsd: 0, tvl: 0, txCountChange: 5, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.results[0].correct).toBe(true);
  });

  it('counts correct categories in evaluation result', () => {
    const snap = makeSnapshot({
      monPriceUsd: 1.00,
      tvl: 100,
      activeCategories: [
        { category: 'whaleTransferFear', intensity: 0.5, direction: 'negative' },
        { category: 'tvlSentiment', intensity: 0.4, direction: 'positive' },
      ],
    });
    // Price dropped (whale correct), TVL held (tvl correct)
    const current = { cycle: 148, monPriceUsd: 0.95, emoPriceUsd: 0, tvl: 100, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.totalCategories).toBe(2);
    expect(result.correctCategories).toBe(2);
  });

  it('handles snapshot with no active categories', () => {
    const snap = makeSnapshot({ activeCategories: [] });
    const current = { cycle: 148, monPriceUsd: 0, emoPriceUsd: 0, tvl: 0, txCountChange: 0, nadFunCreates: 0, dexVolume1h: 0, kuruSpreadPct: 0 };
    const result = evaluateProphecy(snap, current);
    expect(result.totalCategories).toBe(0);
    expect(result.correctCategories).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

// ─── updateProphecyStats ────────────────────────────────────────────────────

describe('updateProphecyStats', () => {
  it('increments totalEvaluated', () => {
    const stats = makeStats();
    const evaluation: ProphecyEvaluation = {
      snapshotCycle: 100, evaluationCycle: 148, evaluatedAt: Date.now(),
      totalCategories: 2, correctCategories: 2,
      results: [
        { category: 'whaleTransferFear', predicted: 'a', actual: 'b', correct: true },
        { category: 'chainActivityJoy', predicted: 'a', actual: 'b', correct: true },
      ],
    };
    updateProphecyStats(stats, evaluation);
    expect(stats.totalEvaluated).toBe(1);
  });

  it('counts evaluation as correct when majority of categories correct', () => {
    const stats = makeStats();
    const evaluation: ProphecyEvaluation = {
      snapshotCycle: 100, evaluationCycle: 148, evaluatedAt: Date.now(),
      totalCategories: 3, correctCategories: 2,
      results: [
        { category: 'whaleTransferFear', predicted: 'a', actual: 'b', correct: true },
        { category: 'chainActivityJoy', predicted: 'a', actual: 'b', correct: true },
        { category: 'tvlSentiment', predicted: 'a', actual: 'b', correct: false },
      ],
    };
    updateProphecyStats(stats, evaluation);
    expect(stats.totalCorrect).toBe(1);
    expect(stats.overallAccuracy).toBe(1.0);
  });

  it('does not count evaluation as correct when minority correct', () => {
    const stats = makeStats();
    const evaluation: ProphecyEvaluation = {
      snapshotCycle: 100, evaluationCycle: 148, evaluatedAt: Date.now(),
      totalCategories: 3, correctCategories: 1,
      results: [
        { category: 'whaleTransferFear', predicted: 'a', actual: 'b', correct: true },
        { category: 'chainActivityJoy', predicted: 'a', actual: 'b', correct: false },
        { category: 'tvlSentiment', predicted: 'a', actual: 'b', correct: false },
      ],
    };
    updateProphecyStats(stats, evaluation);
    expect(stats.totalCorrect).toBe(0);
    expect(stats.overallAccuracy).toBe(0);
  });

  it('tracks per-category accuracy', () => {
    const stats = makeStats();
    const evaluation: ProphecyEvaluation = {
      snapshotCycle: 100, evaluationCycle: 148, evaluatedAt: Date.now(),
      totalCategories: 2, correctCategories: 1,
      results: [
        { category: 'whaleTransferFear', predicted: 'a', actual: 'b', correct: true },
        { category: 'chainActivityJoy', predicted: 'a', actual: 'b', correct: false },
      ],
    };
    updateProphecyStats(stats, evaluation);
    expect(stats.categoryAccuracy['whaleTransferFear']).toBe(1.0);
    expect(stats.categoryAccuracy['chainActivityJoy']).toBe(0);
    expect(stats.categoryEvaluated['whaleTransferFear']).toBe(1);
    expect(stats.categoryCorrect['whaleTransferFear']).toBe(1);
  });

  it('accumulates across multiple evaluations', () => {
    const stats = makeStats();
    for (let i = 0; i < 3; i++) {
      updateProphecyStats(stats, {
        snapshotCycle: i, evaluationCycle: i + 48, evaluatedAt: Date.now(),
        totalCategories: 1, correctCategories: i < 2 ? 1 : 0,
        results: [{ category: 'whaleTransferFear', predicted: 'a', actual: 'b', correct: i < 2 }],
      });
    }
    expect(stats.totalEvaluated).toBe(3);
    expect(stats.totalCorrect).toBe(2);
    expect(stats.overallAccuracy).toBeCloseTo(2 / 3, 5);
    expect(stats.categoryAccuracy['whaleTransferFear']).toBeCloseTo(2 / 3, 5);
    expect(stats.recentEvaluations).toHaveLength(3);
  });
});

// ─── getPendingEvaluations ──────────────────────────────────────────────────

describe('getPendingEvaluations', () => {
  it('returns snapshots that are 48+ cycles old and unevaluated', () => {
    const snapshots: ProphecySnapshot[] = [
      makeSnapshot({ cycle: 10, evaluated: false }),
      makeSnapshot({ cycle: 50, evaluated: false }),
      makeSnapshot({ cycle: 55, evaluated: false }),
    ];
    const pending = getPendingEvaluations(snapshots, 60);
    expect(pending).toHaveLength(1);
    expect(pending[0].cycle).toBe(10);
  });

  it('excludes already-evaluated snapshots', () => {
    const snapshots: ProphecySnapshot[] = [
      makeSnapshot({ cycle: 10, evaluated: true }),
    ];
    const pending = getPendingEvaluations(snapshots, 60);
    expect(pending).toHaveLength(0);
  });

  it('returns empty when no snapshots are old enough', () => {
    const snapshots: ProphecySnapshot[] = [
      makeSnapshot({ cycle: 50, evaluated: false }),
    ];
    const pending = getPendingEvaluations(snapshots, 60);
    expect(pending).toHaveLength(0);
  });
});

// ─── formatProphecyForPrompt ────────────────────────────────────────────────

describe('formatProphecyForPrompt', () => {
  it('returns placeholder when no evaluations yet', () => {
    const stats = makeStats();
    const text = formatProphecyForPrompt(stats);
    expect(text).toContain('No evaluations yet');
    expect(text).toContain('48 cycles');
  });

  it('includes accuracy when evaluations exist', () => {
    const stats = makeStats();
    stats.totalEvaluated = 10;
    stats.totalCorrect = 7;
    stats.overallAccuracy = 0.7;
    stats.categoryAccuracy = { whaleTransferFear: 0.9, chainActivityJoy: 0.4 };
    stats.categoryEvaluated = { whaleTransferFear: 5, chainActivityJoy: 5 };
    const text = formatProphecyForPrompt(stats);
    expect(text).toContain('70.0%');
    expect(text).toContain('7/10');
    expect(text).toContain('Best predictor');
    expect(text).toContain('Worst predictor');
  });

  it('includes recent trend when 3+ recent evaluations', () => {
    const stats = makeStats();
    stats.totalEvaluated = 5;
    stats.totalCorrect = 3;
    stats.overallAccuracy = 0.6;
    stats.recentEvaluations = Array.from({ length: 5 }, (_, i) => ({
      snapshotCycle: i, evaluationCycle: i + 48, evaluatedAt: Date.now(),
      totalCategories: 2, correctCategories: i < 3 ? 2 : 0,
      results: [],
    }));
    const text = formatProphecyForPrompt(stats);
    expect(text).toContain('Recent trend');
  });
});
