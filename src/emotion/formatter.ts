import { PrimaryEmotion, EmotionState } from './types.js';
import { getIntensityLabel } from './engine.js';

function intensityBucket(value: number): string {
  if (value < 0.10) return 'barely there';
  if (value < 0.25) return 'faint';
  if (value < 0.40) return 'moderate';
  if (value < 0.55) return 'strong';
  if (value < 0.70) return 'intense';
  if (value < 0.85) return 'overwhelming';
  return 'all-consuming';
}

export function formatEmotionForPrompt(state: EmotionState): string {
  const lines: string[] = ['Current Emotional State (how you feel right now):'];

  // Sort by intensity, only show meaningful emotions
  const sorted = (Object.entries(state.emotions) as [PrimaryEmotion, number][])
    .sort(([, a], [, b]) => b - a);

  for (const [emotion, value] of sorted) {
    const label = getIntensityLabel(emotion, value);
    const bucket = intensityBucket(value);
    if (value >= 0.10) {
      lines.push(`  ${emotion}: ${bucket} (${label})`);
    }
  }

  // Show faint/dormant emotions as a group
  const dormant = sorted.filter(([, v]) => v < 0.10).map(([e]) => e);
  if (dormant.length > 0) {
    lines.push(`  dormant: ${dormant.join(', ')}`);
  }

  if (state.compounds.length > 0) {
    lines.push(`\nCompound Emotions: ${state.compounds.join(', ')}`);
  }

  lines.push(`Dominant feeling: ${state.dominantLabel} (${state.dominant})`);
  lines.push(`What triggered it: ${state.trigger}`);
  lines.push(`\nIMPORTANT: These are YOUR feelings. Express them naturally in your own voice. Do NOT report these labels, percentages, or dimension names in your posts. Translate them into how they actually feel.`);

  return lines.join('\n');
}

export function emotionToContractValues(state: EmotionState): number[] {
  return [
    Math.round(state.emotions[PrimaryEmotion.JOY] * 255),
    Math.round(state.emotions[PrimaryEmotion.TRUST] * 255),
    Math.round(state.emotions[PrimaryEmotion.FEAR] * 255),
    Math.round(state.emotions[PrimaryEmotion.SURPRISE] * 255),
    Math.round(state.emotions[PrimaryEmotion.SADNESS] * 255),
    Math.round(state.emotions[PrimaryEmotion.DISGUST] * 255),
    Math.round(state.emotions[PrimaryEmotion.ANGER] * 255),
    Math.round(state.emotions[PrimaryEmotion.ANTICIPATION] * 255)
  ];
}

export function formatEmotionHistory(history: EmotionState[]): string {
  if (history.length === 0) return 'No previous emotion history yet.';

  const lines: string[] = [];
  const recent = history.slice(-5);

  for (const state of recent) {
    const time = new Date(state.lastUpdated).toISOString();
    lines.push(`[${time}] ${state.dominantLabel} (${state.dominant}) - trigger: ${state.trigger}`);
    if (state.compounds.length > 0) {
      lines.push(`  compounds: ${state.compounds.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export function formatPreviousPosts(posts: string[]): string {
  if (posts.length === 0) return 'No previous posts yet (this is your first cycle).';

  return posts.slice(-3).map((p, i) => `${i + 1}. ${p}`).join('\n');
}
