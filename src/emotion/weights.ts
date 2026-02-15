import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import type { StrategyWeights, StrategyWeightKey, WeightAdjustment, EmotionStimulus } from './types.js';

const WEIGHTS_FILE = join(STATE_DIR, 'strategy-weights.json');
const WEIGHT_FLOOR = 0.3;
const WEIGHT_CEILING = 2.0;
const DECAY_RATE = 0.005;  // slow decay so learning persists (~140 cycles to halve a deviation)

const MAGNITUDE_STEPS: Record<string, number> = {
  nudge: 0.05,
  moderate: 0.1,
  strong: 0.2,
};

const ALL_WEIGHT_KEYS: StrategyWeightKey[] = [
  'whaleTransferFear', 'chainActivityJoy', 'chainQuietSadness', 'failedTxAnger',
  'nadFunExcitement', 'emoPriceSentiment', 'monPriceSentiment', 'tvlSentiment',
  'socialEngagement', 'selfPerformanceReaction', 'ecosystemVolume', 'gasPressure',
  'githubStarReaction', 'feedJoy', 'dexScreenerMarket', 'kuruOrderbook',
];

export function createDefaultWeights(): StrategyWeights {
  const weights = {} as Record<StrategyWeightKey, number>;
  for (const key of ALL_WEIGHT_KEYS) {
    weights[key] = 1.0;
  }
  return { weights, lastUpdated: Date.now() };
}

export function loadStrategyWeights(): StrategyWeights {
  try {
    const data = readFileSync(WEIGHTS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Ensure all keys exist (forward compatibility)
    for (const key of ALL_WEIGHT_KEYS) {
      if (parsed.weights[key] === undefined) parsed.weights[key] = 1.0;
    }
    return parsed;
  } catch {
    return createDefaultWeights();
  }
}

export function saveStrategyWeights(sw: StrategyWeights): void {
  ensureStateDir();
  sw.lastUpdated = Date.now();
  atomicWriteFileSync(WEIGHTS_FILE, JSON.stringify(sw, null, 2));
}

export interface WeightAdjustmentResult {
  category: StrategyWeightKey;
  before: number;
  after: number;
  reason: string;
  magnitude?: string;
  direction?: string;
}

export function applyWeightAdjustments(sw: StrategyWeights, adjustments: WeightAdjustment[]): WeightAdjustmentResult[] {
  const results: WeightAdjustmentResult[] = [];
  for (const adj of adjustments) {
    if (!ALL_WEIGHT_KEYS.includes(adj.key)) continue;
    const current = sw.weights[adj.key];

    if (adj.direction === 'reset') {
      sw.weights[adj.key] = 1.0;
      console.log(`[Weights] ${adj.key}: ${current.toFixed(2)} → 1.00 (reset: ${adj.reason.slice(0, 80)})`);
      results.push({ category: adj.key, before: current, after: 1.0, reason: adj.reason, direction: 'reset' });
      continue;
    }

    const step = MAGNITUDE_STEPS[adj.magnitude ?? 'moderate'] ?? 0.1;
    const delta = adj.direction === 'increase' ? step : -step;
    sw.weights[adj.key] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, current + delta));
    console.log(`[Weights] ${adj.key}: ${current.toFixed(2)} → ${sw.weights[adj.key].toFixed(2)} (${adj.direction} ${adj.magnitude ?? 'moderate'}: ${adj.reason.slice(0, 80)})`);
    results.push({ category: adj.key, before: current, after: sw.weights[adj.key], reason: adj.reason, magnitude: adj.magnitude, direction: adj.direction });
  }
  return results;
}

export function decayWeights(sw: StrategyWeights): void {
  for (const key of ALL_WEIGHT_KEYS) {
    const w = sw.weights[key];
    // Drift toward 1.0 by DECAY_RATE per cycle
    sw.weights[key] = w + (1.0 - w) * DECAY_RATE;
  }
}

export function applyStrategyWeights(stimuli: EmotionStimulus[], sw: StrategyWeights): EmotionStimulus[] {
  return stimuli.map(s => {
    if (!s.weightCategory) return s;
    const weight = sw.weights[s.weightCategory] ?? 1.0;
    return { ...s, intensity: s.intensity * weight };
  });
}

export { ALL_WEIGHT_KEYS };
