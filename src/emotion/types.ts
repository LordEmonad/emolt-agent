// The 8 primary emotions from Plutchik's model
export enum PrimaryEmotion {
  JOY = 'joy',
  TRUST = 'trust',
  FEAR = 'fear',
  SURPRISE = 'surprise',
  SADNESS = 'sadness',
  DISGUST = 'disgust',
  ANGER = 'anger',
  ANTICIPATION = 'anticipation'
}

// Each emotion has 3 intensity tiers
export interface IntensityTier {
  mild: string;     // 0.0 - 0.33
  moderate: string; // 0.34 - 0.66
  intense: string;  // 0.67 - 1.0
}

// The intensity labels for each primary emotion
export const INTENSITY_TIERS: Record<PrimaryEmotion, IntensityTier> = {
  [PrimaryEmotion.JOY]:          { mild: 'serenity',      moderate: 'joy',          intense: 'ecstasy' },
  [PrimaryEmotion.TRUST]:        { mild: 'acceptance',    moderate: 'trust',        intense: 'admiration' },
  [PrimaryEmotion.FEAR]:         { mild: 'apprehension',  moderate: 'fear',         intense: 'terror' },
  [PrimaryEmotion.SURPRISE]:     { mild: 'distraction',   moderate: 'surprise',     intense: 'amazement' },
  [PrimaryEmotion.SADNESS]:      { mild: 'pensiveness',   moderate: 'sadness',      intense: 'grief' },
  [PrimaryEmotion.DISGUST]:      { mild: 'boredom',       moderate: 'disgust',      intense: 'loathing' },
  [PrimaryEmotion.ANGER]:        { mild: 'annoyance',     moderate: 'anger',        intense: 'rage' },
  [PrimaryEmotion.ANTICIPATION]: { mild: 'interest',      moderate: 'anticipation', intense: 'vigilance' }
};

// 4 opposing pairs - stimulating one suppresses the other
export const OPPOSITION_PAIRS: [PrimaryEmotion, PrimaryEmotion][] = [
  [PrimaryEmotion.JOY, PrimaryEmotion.SADNESS],
  [PrimaryEmotion.TRUST, PrimaryEmotion.DISGUST],
  [PrimaryEmotion.FEAR, PrimaryEmotion.ANGER],
  [PrimaryEmotion.SURPRISE, PrimaryEmotion.ANTICIPATION]
];

// Compound emotions (primary dyads - adjacent emotions)
export const COMPOUND_EMOTIONS: Record<string, { a: PrimaryEmotion; b: PrimaryEmotion; name: string }> = {
  love:           { a: PrimaryEmotion.JOY,          b: PrimaryEmotion.TRUST,        name: 'Love' },
  submission:     { a: PrimaryEmotion.TRUST,        b: PrimaryEmotion.FEAR,         name: 'Submission' },
  awe:            { a: PrimaryEmotion.FEAR,         b: PrimaryEmotion.SURPRISE,     name: 'Awe' },
  disapproval:    { a: PrimaryEmotion.SURPRISE,     b: PrimaryEmotion.SADNESS,      name: 'Disapproval' },
  remorse:        { a: PrimaryEmotion.SADNESS,      b: PrimaryEmotion.DISGUST,      name: 'Remorse' },
  contempt:       { a: PrimaryEmotion.DISGUST,      b: PrimaryEmotion.ANGER,        name: 'Contempt' },
  aggressiveness: { a: PrimaryEmotion.ANGER,        b: PrimaryEmotion.ANTICIPATION, name: 'Aggressiveness' },
  optimism:       { a: PrimaryEmotion.ANTICIPATION,  b: PrimaryEmotion.JOY,         name: 'Optimism' }
};

// Secondary dyads (emotions 2 apart)
export const SECONDARY_COMPOUNDS: Record<string, { a: PrimaryEmotion; b: PrimaryEmotion; name: string }> = {
  guilt:     { a: PrimaryEmotion.JOY,          b: PrimaryEmotion.FEAR,         name: 'Guilt' },
  curiosity: { a: PrimaryEmotion.TRUST,        b: PrimaryEmotion.SURPRISE,     name: 'Curiosity' },
  despair:   { a: PrimaryEmotion.FEAR,         b: PrimaryEmotion.SADNESS,      name: 'Despair' },
  envy:      { a: PrimaryEmotion.SADNESS,      b: PrimaryEmotion.ANGER,        name: 'Envy' },
  cynicism:  { a: PrimaryEmotion.DISGUST,      b: PrimaryEmotion.ANTICIPATION, name: 'Cynicism' },
  pride:     { a: PrimaryEmotion.ANGER,        b: PrimaryEmotion.JOY,          name: 'Pride' },
  hope:      { a: PrimaryEmotion.ANTICIPATION,  b: PrimaryEmotion.TRUST,       name: 'Hope' },
  anxiety:   { a: PrimaryEmotion.ANTICIPATION,  b: PrimaryEmotion.FEAR,        name: 'Anxiety' }
};

// The full emotion state
export interface EmotionState {
  // Primary emotions (0.0 to 1.0)
  emotions: Record<PrimaryEmotion, number>;

  // Detected compound emotions
  compounds: string[];

  // Dominant emotion (highest intensity)
  dominant: PrimaryEmotion;

  // Dominant intensity label
  dominantLabel: string;

  // Timestamp of last update
  lastUpdated: number;

  // What triggered the last change
  trigger: string;

  // Private inner monologue describing current mood (dashboard-only, never posted)
  moodNarrative?: string;

  // Mood (slow-moving average, represents long-term temperament)
  mood: Record<PrimaryEmotion, number>;
}

// Strategy weight category keys
export type StrategyWeightKey =
  | 'whaleTransferFear'
  | 'chainActivityJoy'
  | 'chainQuietSadness'
  | 'failedTxAnger'
  | 'nadFunExcitement'
  | 'emoPriceSentiment'
  | 'monPriceSentiment'
  | 'tvlSentiment'
  | 'socialEngagement'
  | 'selfPerformanceReaction'
  | 'ecosystemVolume'
  | 'gasPressure'
  | 'githubStarReaction';

// A stimulus that affects emotions
export interface EmotionStimulus {
  emotion: PrimaryEmotion;
  intensity: number; // 0.0 to 1.0, how strong this stimulus is
  source: string;    // human-readable description of what caused it
  weightCategory?: StrategyWeightKey;
}

// Strategy weights for adjusting stimulus impact
export interface StrategyWeights {
  weights: Record<StrategyWeightKey, number>;
  lastUpdated: number;
}

// A weight adjustment from reflection
export interface WeightAdjustment {
  key: StrategyWeightKey;
  direction: 'increase' | 'decrease';
  reason: string;
}

// Emotional inertia - resistance to changing away from streak emotion
export interface EmotionInertia {
  streakEmotion: PrimaryEmotion;
  streakLength: number;
}

// Emotional memory for pattern recognition
export interface EmotionMemory {
  recentStates: EmotionState[];  // last 12 cycles (6 hours)
  dominantStreak: number;        // how many cycles the same emotion has been dominant
  streakEmotion: PrimaryEmotion; // which emotion has been dominant
  averageIntensity: number;      // mean intensity across all emotions over recent history
  volatility: number;            // how much emotions have swung (std dev of dominant intensity)
}

// Rolling averages for adaptive thresholds (EMA)
export interface RollingAverages {
  whaleTransferMon: number;
  failedTxCount: number;
  newContracts: number;
  txCountChange: number;
  nadFunCreates: number;
  nadFunGraduations: number;
  emoPriceChangePercent: number;
  emoBuyCount: number;
  emoSellCount: number;
  emoNetFlowMon: number;
  emoSwapCount: number;
  monChange24h: number;
  monCyclePriceChange: number;
  tvlChange24h: number;
  monadTVL: number;
  monVolume24h: number;
  gasPriceGwei: number;
  ecosystemTokenChange: number;
  cyclesTracked: number;
  lastUpdated: number;
}

// Adaptive thresholds derived from rolling averages
export interface AdaptiveThresholds {
  whaleTransferMon: number;
  failedTxCount: number;
  newContracts: number;
  txCountChangeBusy: number;
  txCountChangeDrop: number;
  nadFunHighCreates: number;
  emoPriceChangePump: number;
  emoPriceChangeDump: number;
  emoBuyCount: number;
  emoSellCount: number;
  emoNetFlowMon: number;
  emoSwapCount: number;
  monChange24hBig: number;
  monChange24hModerate: number;
  monCyclePriceChange: number;
  tvlChange24h: number;
  monVolume24hHigh: number;
  monVolume24hLow: number;
  gasPriceGwei: number;
  ecosystemTokenChange: number;
}

// Self-performance tracking
export interface SelfPerformance {
  totalPostsLast24h: number;
  avgUpvotesRecent: number;      // average upvotes on last 5 posts
  avgUpvotesPrevious: number;    // average upvotes on posts 6-10
  postsWithZeroEngagement: number; // posts with 0 upvotes and 0 comments
  bestPostUpvotes: number;        // highest upvotes on any recent post
  commentsReceivedTotal: number;  // total comments across recent posts
}

// Price data for MON token
export interface PriceData {
  currentPrice: number;       // USD
  change24h: number;          // percentage (-100 to +∞)
  previousPrice: number;      // from last cycle (stored in state)
  cyclePriceChange: number;   // % change since last heartbeat
}

// Time context for awareness
export interface TimeContext {
  hour: number;          // 0-23 UTC
  dayOfWeek: number;     // 0=Sunday, 6=Saturday
  isWeekend: boolean;
  isLateNight: boolean;  // 11pm-5am UTC
  isPeakHours: boolean;  // 2pm-10pm UTC (when crypto is most active)
}
