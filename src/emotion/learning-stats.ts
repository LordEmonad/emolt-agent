/**
 * Learning Stats — Back-calculate learning intensity from current weights
 * Even without history, we can infer how many adjustments were needed
 * to reach current weights given constant decay fighting back.
 */

import type { StrategyWeightKey, StrategyWeights } from './types.js';

const DECAY_RATE = 0.005;
const STRONG_STEP = 0.20;
const NEUTRAL_BAND = 0.05;  // within ±0.05 of 1.0 = neutral

export interface CategoryStats {
  category: StrategyWeightKey;
  currentWeight: number;
  deviationFromDefault: number;
  direction: 'dampened' | 'amplified' | 'neutral';
  learningIntensity: 'extreme' | 'strong' | 'moderate' | 'mild' | 'none';
  estimatedAdjustments: number;
  narrative: string;
}

export interface LearningStats {
  categories: CategoryStats[];
  totalDeviation: number;
  mostLearned: StrategyWeightKey;
  leastLearned: StrategyWeightKey;
  overallNarrative: string;
  amplifiedCategories: string[];
  dampenedCategories: string[];
  unchangedCategories: string[];
}

const CATEGORY_LABELS: Record<StrategyWeightKey, string> = {
  whaleTransferFear: 'whale transfers',
  chainActivityJoy: 'chain activity',
  chainQuietSadness: 'chain quiet periods',
  failedTxAnger: 'failed transactions',
  nadFunExcitement: 'nad.fun launches',
  emoPriceSentiment: '$EMO price moves',
  monPriceSentiment: 'MON price moves',
  tvlSentiment: 'TVL changes',
  socialEngagement: 'social engagement',
  selfPerformanceReaction: 'self performance',
  ecosystemVolume: 'ecosystem volume',
  gasPressure: 'gas pressure',
  githubStarReaction: 'GitHub stars',
  feedJoy: 'feed activity',
  dexScreenerMarket: 'DEX market data',
  kuruOrderbook: 'Kuru orderbook',
};

/**
 * Estimate minimum strong adjustments needed to reach currentWeight
 * from 1.0, given decay pulling back each cycle.
 *
 * Simulation: start at 1.0, apply decay cycleCount times, injecting
 * strong adjustments (each -0.20 or +0.20) until final value matches target.
 */
export function estimateMinAdjustments(currentWeight: number, cycleCount: number): number {
  if (Math.abs(currentWeight - 1.0) < NEUTRAL_BAND) return 0;

  const target = currentWeight;
  const direction = target < 1.0 ? -1 : 1;
  const step = STRONG_STEP * direction;

  // Binary search on number of adjustments
  // Spread them evenly across cycles
  for (let numAdj = 1; numAdj <= 200; numAdj++) {
    // Space adjustments evenly across cycles
    const spacing = Math.max(1, Math.floor(cycleCount / numAdj));
    let w = 1.0;
    let adjsApplied = 0;

    for (let c = 0; c < cycleCount; c++) {
      // Decay first
      w = w + (1.0 - w) * DECAY_RATE;
      // Apply adjustment at even intervals
      if (adjsApplied < numAdj && c % spacing === 0) {
        w = Math.max(0.3, Math.min(2.0, w + step));
        adjsApplied++;
      }
    }

    // Check if we reached or passed the target
    if (direction < 0 && w <= target) return numAdj;
    if (direction > 0 && w >= target) return numAdj;
  }

  return 200; // extremely learned
}

function getIntensity(deviation: number): CategoryStats['learningIntensity'] {
  const abs = Math.abs(deviation);
  if (abs < NEUTRAL_BAND) return 'none';
  if (abs < 0.15) return 'mild';
  if (abs < 0.35) return 'moderate';
  if (abs < 0.55) return 'strong';
  return 'extreme';
}

function buildCategoryNarrative(cat: StrategyWeightKey, stats: Omit<CategoryStats, 'narrative'>): string {
  const label = CATEGORY_LABELS[cat];
  if (stats.direction === 'neutral') {
    return `EMOLT found ${label} to be a reliable signal — weight unchanged at ${stats.currentWeight.toFixed(2)}.`;
  }

  const pct = Math.abs(stats.deviationFromDefault * 100).toFixed(0);

  if (stats.direction === 'dampened') {
    return `EMOLT learned that ${label} overreact to noise. Over time, the reflection system reduced this weight by ~${pct}%, requiring an estimated ${stats.estimatedAdjustments}+ strong decreases to overcome decay pulling it back toward neutral.`;
  }

  return `EMOLT discovered that ${label} are undervalued as emotional signals. The weight was amplified by ~${pct}%, fighting against decay with an estimated ${stats.estimatedAdjustments}+ strong increases.`;
}

export function computeLearningStats(sw: StrategyWeights, cycleCount: number): LearningStats {
  const categories: CategoryStats[] = [];
  let totalDeviation = 0;
  let maxDev = 0;
  let minDev = Infinity;
  let mostLearned: StrategyWeightKey = 'chainActivityJoy';
  let leastLearned: StrategyWeightKey = 'chainActivityJoy';

  const amplified: string[] = [];
  const dampened: string[] = [];
  const unchanged: string[] = [];

  for (const [key, value] of Object.entries(sw.weights) as [StrategyWeightKey, number][]) {
    const deviation = value - 1.0;
    const absDev = Math.abs(deviation);
    totalDeviation += absDev;

    const direction: CategoryStats['direction'] =
      deviation < -NEUTRAL_BAND ? 'dampened' :
      deviation > NEUTRAL_BAND ? 'amplified' : 'neutral';

    const estimatedAdj = estimateMinAdjustments(value, cycleCount);

    const partial: Omit<CategoryStats, 'narrative'> = {
      category: key,
      currentWeight: value,
      deviationFromDefault: deviation,
      direction,
      learningIntensity: getIntensity(deviation),
      estimatedAdjustments: estimatedAdj,
    };

    categories.push({
      ...partial,
      narrative: buildCategoryNarrative(key, partial),
    });

    if (absDev > maxDev) { maxDev = absDev; mostLearned = key; }
    if (absDev < minDev) { minDev = absDev; leastLearned = key; }

    if (direction === 'amplified') amplified.push(key);
    else if (direction === 'dampened') dampened.push(key);
    else unchanged.push(key);
  }

  // Sort by deviation descending
  categories.sort((a, b) => Math.abs(b.deviationFromDefault) - Math.abs(a.deviationFromDefault));

  const overallNarrative = generateLearningNarrative({
    categories, totalDeviation, mostLearned, leastLearned,
    overallNarrative: '', amplifiedCategories: amplified,
    dampenedCategories: dampened, unchangedCategories: unchanged,
  }, cycleCount);

  return {
    categories,
    totalDeviation,
    mostLearned,
    leastLearned,
    overallNarrative,
    amplifiedCategories: amplified,
    dampenedCategories: dampened,
    unchangedCategories: unchanged,
  };
}

function generateLearningNarrative(stats: LearningStats, cycleCount: number): string {
  const parts: string[] = [];

  parts.push(`Over ${cycleCount} cycles, EMOLT independently adjusted ${stats.dampenedCategories.length + stats.amplifiedCategories.length} of 16 stimulus categories.`);

  if (stats.dampenedCategories.length > 0) {
    const topDampened = stats.categories
      .filter(c => c.direction === 'dampened')
      .slice(0, 3)
      .map(c => CATEGORY_LABELS[c.category]);
    parts.push(`It learned to dampen sensitivity to ${topDampened.join(', ')}.`);
  }

  if (stats.amplifiedCategories.length > 0) {
    const topAmplified = stats.categories
      .filter(c => c.direction === 'amplified')
      .map(c => CATEGORY_LABELS[c.category]);
    parts.push(`It amplified ${topAmplified.join(', ')}.`);
  }

  parts.push('No human told it to do this.');

  return parts.join(' ');
}
