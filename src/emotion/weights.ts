import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import type { StrategyWeights, StrategyWeightKey, WeightAdjustment, EmotionStimulus } from './types.js';

const WEIGHTS_FILE = join(STATE_DIR, 'strategy-weights.json');
const WEIGHT_STEP = 0.1;
const WEIGHT_FLOOR = 0.3;
const WEIGHT_CEILING = 2.0;
const DECAY_RATE = 0.02;

const ALL_WEIGHT_KEYS: StrategyWeightKey[] = [
  'whaleTransferFear', 'chainActivityJoy', 'chainQuietSadness', 'failedTxAnger',
  'nadFunExcitement', 'emoPriceSentiment', 'monPriceSentiment', 'tvlSentiment',
  'socialEngagement', 'selfPerformanceReaction', 'ecosystemVolume', 'gasPressure',
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

export function applyWeightAdjustments(sw: StrategyWeights, adjustments: WeightAdjustment[]): void {
  for (const adj of adjustments) {
    if (!ALL_WEIGHT_KEYS.includes(adj.key)) continue;
    const current = sw.weights[adj.key];
    const delta = adj.direction === 'increase' ? WEIGHT_STEP : -WEIGHT_STEP;
    sw.weights[adj.key] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, current + delta));
    console.log(`[Weights] ${adj.key}: ${current.toFixed(2)} → ${sw.weights[adj.key].toFixed(2)} (${adj.direction}: ${adj.reason.slice(0, 80)})`);
  }
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
