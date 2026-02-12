import {
  PrimaryEmotion,
  EmotionState,
  EmotionStimulus,
  EmotionInertia,
  INTENSITY_TIERS,
  OPPOSITION_PAIRS,
  COMPOUND_EMOTIONS,
  SECONDARY_COMPOUNDS
} from './types.js';

const DECAY_RATE = 0.05; // per minute
const BASELINE = 0.15;   // resting emotional level
const COMPOUND_THRESHOLD = 0.3;
const MOOD_ALPHA_MIN = 0.05;  // slow mood shift in calm periods
const MOOD_ALPHA_MAX = 0.2;   // faster shift during volatile periods

export function getOpposite(emotion: PrimaryEmotion): PrimaryEmotion | null {
  for (const [a, b] of OPPOSITION_PAIRS) {
    if (a === emotion) return b;
    if (b === emotion) return a;
  }
  return null;
}

export function getDominant(emotions: Record<PrimaryEmotion, number>): PrimaryEmotion {
  let maxEmotion = PrimaryEmotion.ANTICIPATION;
  let maxValue = -1;
  for (const emotion of Object.values(PrimaryEmotion)) {
    if (emotions[emotion] > maxValue) {
      maxValue = emotions[emotion];
      maxEmotion = emotion;
    }
  }
  return maxEmotion;
}

export function getIntensityLabel(emotion: PrimaryEmotion, value: number): string {
  const tier = INTENSITY_TIERS[emotion];
  if (value <= 0.33) return tier.mild;
  if (value <= 0.66) return tier.moderate;
  return tier.intense;
}

export function detectCompounds(emotions: Record<PrimaryEmotion, number>): string[] {
  const compounds: string[] = [];

  // Use geometric mean - allows one high + one moderate to trigger compound
  // e.g. Joy=0.6, Trust=0.2 → sqrt(0.12) = 0.346 > 0.3 ✓ (rigid would reject)
  for (const [, dyad] of Object.entries(COMPOUND_EMOTIONS)) {
    const geoMean = Math.sqrt(emotions[dyad.a] * emotions[dyad.b]);
    if (geoMean >= COMPOUND_THRESHOLD) {
      compounds.push(dyad.name);
    }
  }

  for (const [, dyad] of Object.entries(SECONDARY_COMPOUNDS)) {
    const geoMean = Math.sqrt(emotions[dyad.a] * emotions[dyad.b]);
    if (geoMean >= COMPOUND_THRESHOLD) {
      compounds.push(dyad.name);
    }
  }

  return compounds;
}

export function getInertiaFactor(streakLength: number): number {
  if (streakLength < 3) return 1.0;
  if (streakLength <= 4) return 0.8;
  if (streakLength <= 6) return 0.7;
  if (streakLength <= 8) return 0.6;
  // Long streaks: inertia weakens — the system should recover, not lock forever
  if (streakLength <= 12) return 0.75;
  return 0.9; // Nearly full sensitivity — extended streaks must be escapable
}

export function stimulate(state: EmotionState, stimuli: EmotionStimulus[], inertia?: EmotionInertia): EmotionState {
  const newEmotions = { ...state.emotions };

  const inertiaFactor = inertia ? getInertiaFactor(inertia.streakLength) : 1.0;
  const streakOpposite = inertia ? getOpposite(inertia.streakEmotion) : null;

  for (const stimulus of stimuli) {
    let effectiveIntensity = stimulus.intensity;

    // Inertia: dampen stimuli that target the opposite of the streak emotion
    if (streakOpposite && stimulus.emotion === streakOpposite) {
      effectiveIntensity *= inertiaFactor;
    }

    // Add stimulus to the target emotion (clamped to 0-1)
    newEmotions[stimulus.emotion] = Math.min(1.0,
      newEmotions[stimulus.emotion] + effectiveIntensity
    );

    // Suppress the opposing emotion
    const opposite = getOpposite(stimulus.emotion);
    if (opposite) {
      let suppression = effectiveIntensity * 0.5;

      // Inertia: dampen suppression that would hit the streak emotion
      if (inertia && opposite === inertia.streakEmotion) {
        suppression *= inertiaFactor;
      }

      newEmotions[opposite] = Math.max(0.0,
        newEmotions[opposite] - suppression
      );
    }
  }

  // Detect compound emotions
  const compounds = detectCompounds(newEmotions);

  // Update dominant
  const dominant = getDominant(newEmotions);
  const dominantLabel = getIntensityLabel(dominant, newEmotions[dominant]);

  // Build trigger description
  const trigger = stimuli.length > 0
    ? stimuli.map(s => s.source).join('; ')
    : state.trigger;

  return {
    ...state,
    emotions: newEmotions,
    compounds,
    dominant,
    dominantLabel,
    trigger,
    lastUpdated: Date.now()
  };
}

export function decay(state: EmotionState, minutesElapsed: number): EmotionState {
  const newEmotions = { ...state.emotions };

  for (const emotion of Object.values(PrimaryEmotion)) {
    const current = newEmotions[emotion];
    const decayFactor = Math.exp(-DECAY_RATE * minutesElapsed);

    // Decay toward baseline from either direction
    newEmotions[emotion] = BASELINE + (current - BASELINE) * decayFactor;
  }

  // Re-detect compounds and dominant after decay
  const compounds = detectCompounds(newEmotions);
  const dominant = getDominant(newEmotions);
  const dominantLabel = getIntensityLabel(dominant, newEmotions[dominant]);

  return {
    ...state,
    emotions: newEmotions,
    compounds,
    dominant,
    dominantLabel
  };
}

export function updateMood(state: EmotionState): EmotionState {
  const newMood = { ...state.mood };

  // Compute volatility: average absolute difference between emotions and mood
  let totalDiff = 0;
  const emotions = Object.values(PrimaryEmotion);
  for (const emotion of emotions) {
    totalDiff += Math.abs(state.emotions[emotion] - state.mood[emotion]);
  }
  const avgDiff = totalDiff / emotions.length;

  // Map volatility to alpha: high divergence = faster mood shift
  const alpha = MOOD_ALPHA_MIN + (MOOD_ALPHA_MAX - MOOD_ALPHA_MIN) * Math.min(avgDiff * 3, 1);

  for (const emotion of emotions) {
    newMood[emotion] = newMood[emotion] * (1 - alpha) +
                        state.emotions[emotion] * alpha;
  }

  return {
    ...state,
    mood: newMood
  };
}

export function createDefaultState(): EmotionState {
  const emotions = {} as Record<PrimaryEmotion, number>;
  const mood = {} as Record<PrimaryEmotion, number>;

  for (const e of Object.values(PrimaryEmotion)) {
    emotions[e] = BASELINE;
    mood[e] = BASELINE;
  }

  // Slightly elevated anticipation at genesis - curious about the world
  // Matches EmotionOracle.sol constructor (anticipation: 76 = 0.30 * 255)
  emotions[PrimaryEmotion.ANTICIPATION] = 0.30;
  mood[PrimaryEmotion.ANTICIPATION] = 0.30;

  return {
    emotions,
    compounds: [],
    dominant: PrimaryEmotion.ANTICIPATION,
    dominantLabel: 'interest',
    lastUpdated: Date.now(),
    trigger: 'initial state - just woke up',
    mood
  };
}
