/**
 * Prophecy Tracker — Snapshot emotional signals each cycle, evaluate
 * 48 cycles (~24h) later to see if the signal was predictive.
 * Feeds accuracy data back into reflection for weight adjustments.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import type { StrategyWeightKey, EmotionStimulus } from './types.js';

const SNAPSHOTS_FILE = join(STATE_DIR, 'prophecy-snapshots.json');
const STATS_FILE = join(STATE_DIR, 'prophecy-stats.json');
const EVALUATION_DELAY = 48; // cycles (~24h at 30min/cycle)
const MAX_SNAPSHOTS = 96;
const MAX_RECENT_EVALS = 50;

// --- Types ---

export interface ProphecySnapshot {
  cycle: number;
  timestamp: number;
  // Key metrics at snapshot time
  monPriceUsd: number;
  emoPriceUsd: number;
  tvl: number;
  txCountChange: number;
  nadFunCreates: number;
  dexVolume1h: number;
  kuruSpreadPct: number;
  gasPriceGwei: number;
  // Which categories had strong stimuli
  activeCategories: { category: StrategyWeightKey; intensity: number; direction: 'positive' | 'negative' }[];
  evaluated: boolean;
}

export interface ProphecyEvaluation {
  snapshotCycle: number;
  evaluationCycle: number;
  evaluatedAt: number;
  totalCategories: number;
  correctCategories: number;
  results: { category: StrategyWeightKey; predicted: string; actual: string; correct: boolean }[];
}

export interface ProphecyStats {
  totalEvaluated: number;
  totalCorrect: number;
  overallAccuracy: number;
  categoryAccuracy: Record<string, number>;
  categoryEvaluated: Record<string, number>;
  categoryCorrect: Record<string, number>;
  recentEvaluations: ProphecyEvaluation[];
  lastUpdated: number;
}

// --- I/O ---

export function loadProphecySnapshots(): ProphecySnapshot[] {
  try {
    const data = readFileSync(SNAPSHOTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveProphecySnapshots(snapshots: ProphecySnapshot[]): void {
  ensureStateDir();
  // Cap at MAX_SNAPSHOTS
  const trimmed = snapshots.slice(-MAX_SNAPSHOTS);
  atomicWriteFileSync(SNAPSHOTS_FILE, JSON.stringify(trimmed, null, 2));
}

export function loadProphecyStats(): ProphecyStats {
  try {
    const data = readFileSync(STATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
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
}

export function saveProphecyStats(stats: ProphecyStats): void {
  ensureStateDir();
  stats.lastUpdated = Date.now();
  // Cap recent evaluations
  if (stats.recentEvaluations.length > MAX_RECENT_EVALS) {
    stats.recentEvaluations = stats.recentEvaluations.slice(-MAX_RECENT_EVALS);
  }
  atomicWriteFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// --- Snapshot Creation ---

interface SnapshotInput {
  cycle: number;
  monPriceUsd: number;
  emoPriceUsd: number;
  tvl: number;
  txCountChange: number;
  nadFunCreates: number;
  dexVolume1h: number;
  kuruSpreadPct: number;
  gasPriceGwei: number;
  stimuli: EmotionStimulus[];
}

export function createProphecySnapshot(input: SnapshotInput): ProphecySnapshot {
  // Find the strongest stimulus per weight category
  const catMap = new Map<StrategyWeightKey, { intensity: number; direction: 'positive' | 'negative' }>();

  for (const s of input.stimuli) {
    if (!s.weightCategory) continue;
    const existing = catMap.get(s.weightCategory);
    if (!existing || s.intensity > existing.intensity) {
      // Determine direction from emotion type
      const positive = ['joy', 'trust', 'anticipation', 'surprise'].includes(s.emotion);
      catMap.set(s.weightCategory, {
        intensity: s.intensity,
        direction: positive ? 'positive' : 'negative',
      });
    }
  }

  const activeCategories = [...catMap.entries()]
    .filter(([, v]) => v.intensity > 0.1) // only meaningful signals
    .map(([category, v]) => ({ category, intensity: v.intensity, direction: v.direction }))
    .sort((a, b) => b.intensity - a.intensity);

  return {
    cycle: input.cycle,
    timestamp: Date.now(),
    monPriceUsd: input.monPriceUsd,
    emoPriceUsd: input.emoPriceUsd,
    tvl: input.tvl,
    txCountChange: input.txCountChange,
    nadFunCreates: input.nadFunCreates,
    dexVolume1h: input.dexVolume1h,
    kuruSpreadPct: input.kuruSpreadPct,
    gasPriceGwei: input.gasPriceGwei,
    activeCategories,
    evaluated: false,
  };
}

// --- Evaluation ---

interface EvaluationData {
  cycle: number;
  monPriceUsd: number;
  emoPriceUsd: number;
  tvl: number;
  txCountChange: number;
  nadFunCreates: number;
  dexVolume1h: number;
  kuruSpreadPct: number;
}

/**
 * Evaluate category-specific predictions against current data.
 * Each category has its own "correct" criterion.
 */
function evaluateCategory(
  category: StrategyWeightKey,
  snapshot: ProphecySnapshot,
  current: EvaluationData,
): { predicted: string; actual: string; correct: boolean } {
  switch (category) {
    case 'whaleTransferFear': {
      const priceDropped = current.monPriceUsd < snapshot.monPriceUsd * 0.98;
      return {
        predicted: 'whale activity signals price risk',
        actual: priceDropped ? 'price dropped 2%+' : 'price held or rose',
        correct: priceDropped,
      };
    }
    case 'chainActivityJoy': {
      const activityUp = current.txCountChange > 0 || current.tvl > snapshot.tvl;
      return {
        predicted: 'chain activity signals growth',
        actual: activityUp ? 'activity/TVL increased' : 'activity/TVL flat or down',
        correct: activityUp,
      };
    }
    case 'monPriceSentiment': {
      // "Correct" if price continued the direction the stimulus suggested
      // Stimulus direction comes from whether the signal was positive or negative
      const stimDir = snapshot.activeCategories.find(a => a.category === 'monPriceSentiment');
      const wasPositive = stimDir?.direction === 'positive';
      const priceWentUp = current.monPriceUsd >= snapshot.monPriceUsd;
      const correct = wasPositive === priceWentUp;
      return {
        predicted: `MON sentiment was ${wasPositive ? 'bullish' : 'bearish'}`,
        actual: priceWentUp ? 'MON rose' : 'MON fell',
        correct,
      };
    }
    case 'emoPriceSentiment': {
      if (snapshot.emoPriceUsd === 0 || current.emoPriceUsd === 0) {
        return { predicted: 'no data', actual: 'no data', correct: false };
      }
      const stimDir = snapshot.activeCategories.find(a => a.category === 'emoPriceSentiment');
      const wasPositive = stimDir?.direction === 'positive';
      const emoUp = current.emoPriceUsd >= snapshot.emoPriceUsd;
      return {
        predicted: `$EMO sentiment was ${wasPositive ? 'bullish' : 'bearish'}`,
        actual: emoUp ? '$EMO rose' : '$EMO fell',
        correct: wasPositive === emoUp,
      };
    }
    case 'tvlSentiment': {
      const tvlUp = current.tvl >= snapshot.tvl * 0.98;
      return {
        predicted: 'TVL trend continues',
        actual: tvlUp ? 'TVL held or grew' : 'TVL dropped 2%+',
        correct: tvlUp,
      };
    }
    case 'nadFunExcitement': {
      const active = current.nadFunCreates >= snapshot.nadFunCreates * 0.8;
      return {
        predicted: 'nad.fun activity sustains',
        actual: active ? 'launches sustained' : 'launches dropped',
        correct: active,
      };
    }
    case 'dexScreenerMarket': {
      const volumeHeld = current.dexVolume1h >= snapshot.dexVolume1h * 0.5;
      return {
        predicted: 'DEX volume sustains',
        actual: volumeHeld ? 'volume held 50%+' : 'volume dropped significantly',
        correct: volumeHeld,
      };
    }
    case 'kuruOrderbook': {
      const spreadOk = current.kuruSpreadPct <= snapshot.kuruSpreadPct * 2;
      return {
        predicted: 'orderbook stability',
        actual: spreadOk ? 'spread stable' : 'spread widened significantly',
        correct: spreadOk,
      };
    }
    default: {
      // Holistic assessment for other categories: check if overall conditions improved
      const priceUp = current.monPriceUsd >= snapshot.monPriceUsd;
      const activityUp = current.txCountChange >= 0;
      return {
        predicted: 'general conditions improve',
        actual: priceUp && activityUp ? 'conditions improved' : 'conditions mixed or worsened',
        correct: priceUp && activityUp,
      };
    }
  }
}

export function evaluateProphecy(
  snapshot: ProphecySnapshot,
  current: EvaluationData,
): ProphecyEvaluation {
  const results: ProphecyEvaluation['results'] = [];

  for (const active of snapshot.activeCategories) {
    const result = evaluateCategory(active.category, snapshot, current);
    results.push({ category: active.category, ...result });
  }

  const correct = results.filter(r => r.correct).length;

  return {
    snapshotCycle: snapshot.cycle,
    evaluationCycle: current.cycle,
    evaluatedAt: Date.now(),
    totalCategories: results.length,
    correctCategories: correct,
    results,
  };
}

export function updateProphecyStats(stats: ProphecyStats, evaluation: ProphecyEvaluation): void {
  stats.totalEvaluated++;
  stats.totalCorrect += evaluation.correctCategories > evaluation.totalCategories / 2 ? 1 : 0;
  stats.overallAccuracy = stats.totalEvaluated > 0 ? stats.totalCorrect / stats.totalEvaluated : 0;

  // Update per-category stats
  for (const r of evaluation.results) {
    const cat = r.category;
    stats.categoryEvaluated[cat] = (stats.categoryEvaluated[cat] || 0) + 1;
    stats.categoryCorrect[cat] = (stats.categoryCorrect[cat] || 0) + (r.correct ? 1 : 0);
    stats.categoryAccuracy[cat] = stats.categoryEvaluated[cat] > 0
      ? stats.categoryCorrect[cat] / stats.categoryEvaluated[cat]
      : 0;
  }

  stats.recentEvaluations.push(evaluation);
}

// --- Pending evaluations ---

export function getPendingEvaluations(
  snapshots: ProphecySnapshot[],
  currentCycle: number,
): ProphecySnapshot[] {
  return snapshots.filter(s =>
    !s.evaluated && currentCycle - s.cycle >= EVALUATION_DELAY,
  );
}

// --- Prompt formatting ---

export function formatProphecyForPrompt(stats: ProphecyStats): string {
  if (stats.totalEvaluated === 0) {
    return '## Prophecy Tracker\nNo evaluations yet. Snapshots are being collected — first evaluation in ~48 cycles.';
  }

  const lines: string[] = ['## Prophecy Tracker'];
  lines.push(`Overall accuracy: ${(stats.overallAccuracy * 100).toFixed(1)}% (${stats.totalCorrect}/${stats.totalEvaluated} evaluations correct)`);

  // Best and worst categories
  const cats = Object.entries(stats.categoryAccuracy)
    .sort(([, a], [, b]) => b - a);

  if (cats.length > 0) {
    const best = cats[0];
    const worst = cats[cats.length - 1];
    lines.push(`Best predictor: ${best[0]} (${(best[1] * 100).toFixed(0)}% accurate)`);
    if (cats.length > 1) {
      lines.push(`Worst predictor: ${worst[0]} (${(worst[1] * 100).toFixed(0)}% accurate)`);
    }
  }

  // Recent trend
  const recent = stats.recentEvaluations.slice(-5);
  if (recent.length >= 3) {
    const recentCorrect = recent.filter(e => e.correctCategories > e.totalCategories / 2).length;
    const trend = recentCorrect >= 3 ? 'improving' : recentCorrect <= 1 ? 'declining' : 'stable';
    lines.push(`Recent trend: ${trend} (${recentCorrect}/${recent.length} recent evaluations correct)`);
  }

  lines.push('');
  lines.push('Use this data to inform weight adjustments: amplify weights for accurate predictors, dampen inaccurate ones.');

  return lines.join('\n');
}
