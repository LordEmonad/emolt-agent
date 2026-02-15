import { PrimaryEmotion, EmotionState, EmotionStimulus, StrategyWeights, EmotionMemory } from '../emotion/types.js';
import { loadProphecyStats } from '../emotion/prophecy.js';

const ALL_EMOTIONS = Object.values(PrimaryEmotion);
const DEAD_THRESHOLD = 0.10;
const DEAD_MIN_CYCLES = 4;
const STACKING_ALERT_THRESHOLD = 0.8;

export interface EmotionDiagnostics {
  report: string;
  deadEmotions: { emotion: PrimaryEmotion; value: number; deadCycles: number }[];
  stackingAlerts: { emotion: PrimaryEmotion; sourceCount: number; totalIntensity: number }[];
  dominantStreak: number;
  streakEmotion: PrimaryEmotion;
}

/** Count how many consecutive recent cycles an emotion has been below threshold */
function countDeadCycles(history: EmotionState[], emotion: PrimaryEmotion): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].emotions[emotion] < DEAD_THRESHOLD) count++;
    else break;
  }
  return count;
}

export function buildDiagnostics(
  preStimuli: Record<PrimaryEmotion, number>,
  postStimuli: EmotionState,
  stimuli: EmotionStimulus[],
  weights: StrategyWeights,
  emotionMemory: EmotionMemory,
): EmotionDiagnostics {
  const lines: string[] = [];

  // --- 1. Before → After deltas ---
  lines.push('EMOTION DIAGNOSTICS');
  lines.push('═══════════════════');
  lines.push('');
  lines.push('Before → After (this cycle):');
  for (const e of ALL_EMOTIONS) {
    const before = preStimuli[e];
    const after = postStimuli.emotions[e];
    const delta = after - before;
    const arrow = delta > 0.01 ? '↑' : delta < -0.01 ? '↓' : '·';
    const marker = e === postStimuli.dominant ? ' ← DOMINANT' : '';
    lines.push(`  ${e.padEnd(13)} ${before.toFixed(2)} → ${after.toFixed(2)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}) ${arrow}${marker}`);
  }

  // --- 2. Dead emotions ---
  const deadEmotions: EmotionDiagnostics['deadEmotions'] = [];
  if (emotionMemory.recentStates.length >= DEAD_MIN_CYCLES) {
    for (const e of ALL_EMOTIONS) {
      const deadCycles = countDeadCycles(emotionMemory.recentStates, e);
      if (deadCycles >= DEAD_MIN_CYCLES) {
        deadEmotions.push({ emotion: e, value: postStimuli.emotions[e], deadCycles });
      }
    }
  }
  if (deadEmotions.length > 0) {
    lines.push('');
    lines.push('Dead emotions (below 0.10 for 4+ cycles):');
    for (const d of deadEmotions) {
      lines.push(`  ${d.emotion}: ${d.value.toFixed(2)} for ${d.deadCycles} cycles`);
    }
  }

  // --- 3. Stimulus stacking per emotion ---
  const stimulusLoad = new Map<PrimaryEmotion, { count: number; total: number }>();
  for (const s of stimuli) {
    const entry = stimulusLoad.get(s.emotion) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += s.intensity;
    stimulusLoad.set(s.emotion, entry);
  }

  const stackingAlerts: EmotionDiagnostics['stackingAlerts'] = [];
  lines.push('');
  lines.push('Stimulus load per emotion:');
  const sorted = [...stimulusLoad.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [emotion, { count, total }] of sorted) {
    const alert = total >= STACKING_ALERT_THRESHOLD ? ' ⚠ STACKING' : '';
    lines.push(`  ${emotion}: ${count} source${count > 1 ? 's' : ''}, total intensity ${total.toFixed(2)}${alert}`);
    if (total >= STACKING_ALERT_THRESHOLD) {
      stackingAlerts.push({ emotion, sourceCount: count, totalIntensity: total });
    }
  }

  // --- 4. Top stimuli by intensity ---
  const topStimuli = [...stimuli].sort((a, b) => b.intensity - a.intensity).slice(0, 8);
  lines.push('');
  lines.push('Top stimuli (by intensity):');
  for (let i = 0; i < topStimuli.length; i++) {
    const s = topStimuli[i];
    const w = s.weightCategory ? weights.weights[s.weightCategory] : 1.0;
    lines.push(`  ${i + 1}. ${s.source} → ${s.emotion} +${(s.intensity * 100).toFixed(0)}% (weight: ${w.toFixed(2)})`);
  }

  // --- 5. Dominance streak ---
  lines.push('');
  lines.push(`Dominance: ${emotionMemory.streakEmotion} for ${emotionMemory.dominantStreak} consecutive cycle${emotionMemory.dominantStreak !== 1 ? 's' : ''}`);
  if (emotionMemory.volatility > 0) {
    lines.push(`Volatility: ${emotionMemory.volatility.toFixed(3)}`);
  }

  // --- 6. Current weight values ---
  const nonDefaultWeights = Object.entries(weights.weights)
    .filter(([, v]) => Math.abs(v - 1.0) > 0.01)
    .sort((a, b) => Math.abs(b[1] - 1.0) - Math.abs(a[1] - 1.0));

  if (nonDefaultWeights.length > 0) {
    lines.push('');
    lines.push('Adjusted weights (non-default):');
    for (const [key, val] of nonDefaultWeights) {
      const dir = val > 1.0 ? 'amplified' : 'dampened';
      lines.push(`  ${key}: ${val.toFixed(2)} (${dir})`);
    }
  } else {
    lines.push('');
    lines.push('All weights at default (1.00)');
  }

  // --- 7. Prophecy accuracy ---
  try {
    const prophecyStats = loadProphecyStats();
    if (prophecyStats.totalEvaluated > 0) {
      lines.push('');
      lines.push(`Prophecy accuracy: ${(prophecyStats.overallAccuracy * 100).toFixed(1)}% (${prophecyStats.totalCorrect}/${prophecyStats.totalEvaluated})`);

      const catEntries = Object.entries(prophecyStats.categoryAccuracy)
        .sort(([, a], [, b]) => b - a);
      if (catEntries.length > 0) {
        const best = catEntries[0];
        const worst = catEntries[catEntries.length - 1];
        lines.push(`  Best predictor: ${best[0]} (${(best[1] * 100).toFixed(0)}%)`);
        if (catEntries.length > 1) {
          lines.push(`  Worst predictor: ${worst[0]} (${(worst[1] * 100).toFixed(0)}%)`);
        }
      }
    }
  } catch {
    // prophecy stats not available yet
  }

  return {
    report: lines.join('\n'),
    deadEmotions,
    stackingAlerts,
    dominantStreak: emotionMemory.dominantStreak,
    streakEmotion: emotionMemory.streakEmotion,
  };
}
