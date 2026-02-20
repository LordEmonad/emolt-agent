import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { EmotionState, SelfPerformance } from '../emotion/types.js';
import type { ChainDataSummary } from '../chain/types.js';
import { createDefaultState } from '../emotion/engine.js';

// Atomic write: write to .tmp then rename to prevent corruption on crash
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, filePath);
}

export const STATE_DIR = './state';
const EMOTION_STATE_FILE = join(STATE_DIR, 'emotion-state.json');
const CHAIN_HISTORY_FILE = join(STATE_DIR, 'chain-history.json');
const RECENT_POSTS_FILE = join(STATE_DIR, 'recent-posts.json');
const EMOTION_LOG_FILE = join(STATE_DIR, 'emotion-log.json');
const PRICE_STATE_FILE = join(STATE_DIR, 'price-state.json');
const POST_PERFORMANCE_FILE = join(STATE_DIR, 'post-performance.json');
const SELF_PERF_PREV_FILE = join(STATE_DIR, 'self-performance-prev.json');
const LAST_POST_TIME_FILE = join(STATE_DIR, 'last-post-time.json');
const GITHUB_STARS_PREV_FILE = join(STATE_DIR, 'github-stars-prev.json');
const LAST_COMMENT_TIME_FILE = join(STATE_DIR, 'last-comment-time.json');

export function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

// --- Emotion State ---

export function loadEmotionState(): EmotionState {
  try {
    const data = readFileSync(EMOTION_STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return createDefaultState();
  }
}

export function saveEmotionState(state: EmotionState): void {
  ensureStateDir();
  atomicWriteFileSync(EMOTION_STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Chain History ---

export function loadChainHistory(): ChainDataSummary | null {
  try {
    const data = readFileSync(CHAIN_HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Restore bigint values that were serialized as strings
    if (parsed.avgGasUsed !== undefined) {
      parsed.avgGasUsed = BigInt(parsed.avgGasUsed);
    }
    if (parsed.largeTransfers) {
      for (const t of parsed.largeTransfers) {
        if (t.value !== undefined) t.value = BigInt(t.value);
        if (t.blockNumber !== undefined) t.blockNumber = BigInt(t.blockNumber);
      }
    }
    if (parsed.incomingNativeTransfers) {
      for (const t of parsed.incomingNativeTransfers) {
        if (t.value !== undefined) t.value = BigInt(t.value);
        if (t.blockNumber !== undefined) t.blockNumber = BigInt(t.blockNumber);
      }
    } else {
      parsed.incomingNativeTransfers = [];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveChainHistory(summary: ChainDataSummary): void {
  ensureStateDir();
  // Convert bigint to string for JSON serialization
  const serializable = {
    ...summary,
    avgGasUsed: summary.avgGasUsed.toString(),
    largeTransfers: summary.largeTransfers.map(t => ({
      ...t,
      value: t.value.toString(),
      blockNumber: t.blockNumber.toString()
    })),
    incomingNativeTransfers: (summary.incomingNativeTransfers || []).map(t => ({
      ...t,
      value: t.value.toString(),
      blockNumber: t.blockNumber.toString()
    }))
  };
  atomicWriteFileSync(CHAIN_HISTORY_FILE, JSON.stringify(serializable, null, 2));
}

// --- Recent Posts ---

export function loadRecentPosts(): string[] {
  try {
    const data = readFileSync(RECENT_POSTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveRecentPost(post: { title: string; content: string }): void {
  ensureStateDir();
  const posts = loadRecentPosts();
  posts.push(`${post.title}: ${post.content}`);
  // Keep only last 10 posts
  const trimmed = posts.slice(-10);
  atomicWriteFileSync(RECENT_POSTS_FILE, JSON.stringify(trimmed, null, 2));
}

// --- Emotion History (append-only log) ---

export function loadEmotionHistory(): EmotionState[] {
  try {
    const data = readFileSync(EMOTION_LOG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function appendEmotionLog(state: EmotionState): void {
  ensureStateDir();
  const history = loadEmotionHistory();
  history.push(state);
  // Keep last 500 entries (matching heartbeat-log.jsonl cap)
  const trimmed = history.slice(-500);
  atomicWriteFileSync(EMOTION_LOG_FILE, JSON.stringify(trimmed, null, 2));
}

// --- Price State ---

export function loadPreviousPrice(): number {
  try {
    const data = readFileSync(PRICE_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed.price ?? 0;
  } catch {
    return 0;
  }
}

export function savePreviousPrice(price: number): void {
  ensureStateDir();
  atomicWriteFileSync(PRICE_STATE_FILE, JSON.stringify({ price, timestamp: Date.now() }, null, 2));
}

// --- Self Performance ---

export function loadPostPerformance(): any[] {
  try {
    const data = readFileSync(POST_PERFORMANCE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function savePostPerformance(performance: any[]): void {
  ensureStateDir();
  atomicWriteFileSync(POST_PERFORMANCE_FILE, JSON.stringify(performance, null, 2));
}

// --- Previous Self Performance (for delta-based stimuli) ---

export function loadPreviousSelfPerformance(): SelfPerformance | null {
  try {
    const data = readFileSync(SELF_PERF_PREV_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function savePreviousSelfPerformance(perf: SelfPerformance): void {
  ensureStateDir();
  atomicWriteFileSync(SELF_PERF_PREV_FILE, JSON.stringify(perf, null, 2));
}

// --- Previous GitHub Star Count (for delta-based stimuli) ---

export function loadPreviousStarCount(): number | null {
  try {
    const data = readFileSync(GITHUB_STARS_PREV_FILE, 'utf-8');
    return JSON.parse(data).stars ?? null;
  } catch {
    return null;
  }
}

export function savePreviousStarCount(stars: number): void {
  ensureStateDir();
  atomicWriteFileSync(GITHUB_STARS_PREV_FILE, JSON.stringify({ stars, timestamp: Date.now() }, null, 2));
}

// --- Last Post Time (rate limit guard) ---

const POST_COOLDOWN_MS = 180 * 60 * 1000; // 3 hours - strict spacing to avoid duplicate_post automod

export function loadLastPostTime(): number {
  try {
    const data = readFileSync(LAST_POST_TIME_FILE, 'utf-8');
    return JSON.parse(data).timestamp || 0;
  } catch {
    return 0;
  }
}

export function saveLastPostTime(): void {
  ensureStateDir();
  atomicWriteFileSync(LAST_POST_TIME_FILE, JSON.stringify({ timestamp: Date.now() }, null, 2));
}

export function canPostNow(): { allowed: boolean; waitMinutes: number; reason?: string } {
  // Check daily cap first
  if (isDailyPostCapReached()) {
    return { allowed: false, waitMinutes: 0, reason: `daily cap reached (${DAILY_POST_CAP}/day)` };
  }
  // Then check cooldown
  const lastPost = loadLastPostTime();
  const elapsed = Date.now() - lastPost;
  if (elapsed >= POST_COOLDOWN_MS) {
    return { allowed: true, waitMinutes: 0 };
  }
  const remaining = POST_COOLDOWN_MS - elapsed;
  return { allowed: false, waitMinutes: Math.ceil(remaining / 60000), reason: 'cooldown' };
}

// --- Daily Post Cap ---
// Max 4 posts per 24h to avoid duplicate_post automod (offense #1 was 9 posts in 12h)

const DAILY_POST_CAP = 4;
const DAILY_POST_TRACKER_FILE = join(STATE_DIR, 'daily-post-tracker.json');

interface DailyPostTracker {
  date: string;        // YYYY-MM-DD
  count: number;
  timestamps: number[];
}

function loadDailyPostTracker(): DailyPostTracker {
  try {
    const data = readFileSync(DAILY_POST_TRACKER_FILE, 'utf-8');
    const tracker = JSON.parse(data);
    const today = new Date().toISOString().slice(0, 10);
    if (tracker.date !== today) {
      return { date: today, count: 0, timestamps: [] };
    }
    return tracker;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), count: 0, timestamps: [] };
  }
}

export function recordDailyPost(): void {
  ensureStateDir();
  const tracker = loadDailyPostTracker();
  tracker.count++;
  tracker.timestamps.push(Date.now());
  atomicWriteFileSync(DAILY_POST_TRACKER_FILE, JSON.stringify(tracker, null, 2));
}

export function getDailyPostCount(): number {
  return loadDailyPostTracker().count;
}

export function isDailyPostCapReached(): boolean {
  return loadDailyPostTracker().count >= DAILY_POST_CAP;
}

// --- Comment Rate Limiting ---
// Moltbook limits: 1 comment/20s, 50/day (new agents: 1/60s, 20/day)
// We use conservative limits: max 40/day, 2 per cycle

const DAILY_COMMENT_LIMIT = 40; // stay under the 50/day hard limit
const MAX_COMMENTS_PER_CYCLE = 2;
const COMMENT_SPACING_MS = 75 * 1000; // 75s between comments (recommended 72s+, limit 20s)

interface CommentTracker {
  date: string;        // YYYY-MM-DD
  count: number;       // comments made today
  lastCommentAt: number; // timestamp of last comment
}

function loadCommentTracker(): CommentTracker {
  try {
    const data = readFileSync(LAST_COMMENT_TIME_FILE, 'utf-8');
    const tracker = JSON.parse(data);
    // Reset if it's a new day
    const today = new Date().toISOString().slice(0, 10);
    if (tracker.date !== today) {
      return { date: today, count: 0, lastCommentAt: 0 };
    }
    return tracker;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), count: 0, lastCommentAt: 0 };
  }
}

export function saveCommentTracker(count: number): void {
  ensureStateDir();
  const tracker: CommentTracker = {
    date: new Date().toISOString().slice(0, 10),
    count,
    lastCommentAt: Date.now(),
  };
  atomicWriteFileSync(LAST_COMMENT_TIME_FILE, JSON.stringify(tracker, null, 2));
}

export function canCommentNow(): { allowed: boolean; remaining: number; maxComments: number; spacingMs: number } {
  const tracker = loadCommentTracker();
  const remaining = DAILY_COMMENT_LIMIT - tracker.count;
  if (remaining <= 0) {
    return { allowed: false, remaining: 0, maxComments: 0, spacingMs: COMMENT_SPACING_MS };
  }
  const maxThisCycle = Math.min(MAX_COMMENTS_PER_CYCLE, remaining);
  return { allowed: true, remaining, maxComments: maxThisCycle, spacingMs: COMMENT_SPACING_MS };
}

export function getDailyCommentCount(): number {
  return loadCommentTracker().count;
}

// --- Heartbeat Log ---

const HEARTBEAT_LOG_FILE = join(STATE_DIR, 'heartbeat-log.jsonl');
const MAX_HEARTBEAT_LOG_LINES = 500;

export interface HeartbeatLogEntry {
  cycle: number;
  timestamp: string;
  emotionBefore: string;
  stimuliCount: number;
  stimuliSummary: string[];
  emotionAfter: string;
  claudeAction: string;
  claudeThinking: string;
  actionResult: string;
  reflectionSummary: string;
  onChainSuccess: boolean;
  durationMs: number;
}

export function appendHeartbeatLog(entry: HeartbeatLogEntry): void {
  ensureStateDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(HEARTBEAT_LOG_FILE, line, 'utf-8');

  // Rotate: keep last MAX_HEARTBEAT_LOG_LINES lines
  try {
    const content = readFileSync(HEARTBEAT_LOG_FILE, 'utf-8');
    const lines = content.trimEnd().split('\n');
    if (lines.length > MAX_HEARTBEAT_LOG_LINES) {
      const trimmed = lines.slice(-MAX_HEARTBEAT_LOG_LINES).join('\n') + '\n';
      atomicWriteFileSync(HEARTBEAT_LOG_FILE, trimmed);
    }
  } catch {
    // rotation failed, not critical
  }
}

// --- Trending Data (for dashboard ticker) ---

const TRENDING_DATA_FILE = join(STATE_DIR, 'trending-data.json');

export interface DexTickerItem {
  name: string;
  priceUsd: number;
  marketCapUsd: number;
  changeH24: number;
}

export interface NadFunTickerItem {
  name: string;
  symbol: string;
  priceUsd: number;
  marketCapUsd: number;
  priceChangePct: number;
}

export interface EmoTickerData {
  priceUsd: number;
  marketCapUsd: number;
  priceChangePct: number;
}

export interface TrendingData {
  dex: DexTickerItem[];
  nadfun: NadFunTickerItem[];
  emo: EmoTickerData | null;
  updatedAt: number;
}

export function loadTrendingData(): TrendingData | null {
  try {
    const data = readFileSync(TRENDING_DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function saveTrendingData(data: TrendingData): void {
  ensureStateDir();
  atomicWriteFileSync(TRENDING_DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Burn Ledger (Feed EMOLT) ---

const BURN_LEDGER_FILE = join(STATE_DIR, 'burn-ledger.json');

export interface FeederRecord {
  address: string;
  totalEmo: string;       // bigint as string
  totalMon: string;       // bigint as string
  totalEmoUsd: number;
  totalMonUsd: number;
  txCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface BurnHistoryEntry {
  txHash: string;
  amount: string;         // bigint as string
  timestamp: number;
  feederAddress: string;
}

export interface BurnLedger {
  feeders: Record<string, FeederRecord>;
  totalEmoBurned: string;       // bigint as string
  totalEmoReceived: string;     // bigint as string
  totalMonReceived: string;     // bigint as string
  totalMonBuyback: string;      // bigint as string — MON spent buying $EMO to burn
  totalValueUsd: number;
  burnHistory: BurnHistoryEntry[];
  processedTxHashes: string[];  // dedup: prevent double-counting on restart
  lastProcessedBlock: string;   // bigint as string (legacy, kept for compat)
  lastProcessedEmoBlock: string; // separate tracking — $EMO tokentx
  lastProcessedMonBlock: string; // separate tracking — MON txlist
  lastUpdated: number;
}

export function createDefaultBurnLedger(): BurnLedger {
  return {
    feeders: {},
    totalEmoBurned: '0',
    totalEmoReceived: '0',
    totalMonReceived: '0',
    totalMonBuyback: '0',
    totalValueUsd: 0,
    burnHistory: [],
    processedTxHashes: [],
    lastProcessedBlock: '0',
    lastProcessedEmoBlock: '0',
    lastProcessedMonBlock: '0',
    lastUpdated: Date.now()
  };
}

export function loadBurnLedger(): BurnLedger {
  try {
    const data = readFileSync(BURN_LEDGER_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return createDefaultBurnLedger();
  }
}

export function saveBurnLedger(ledger: BurnLedger): void {
  ensureStateDir();
  // Keep burnHistory capped at 100 entries
  if (ledger.burnHistory.length > 100) {
    ledger.burnHistory = ledger.burnHistory.slice(-100);
  }
  ledger.lastUpdated = Date.now();
  atomicWriteFileSync(BURN_LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

export function calculateSelfPerformance(): SelfPerformance {
  const posts = loadPostPerformance();

  if (posts.length === 0) {
    return {
      totalPostsLast24h: 0,
      avgUpvotesRecent: 0,
      avgUpvotesPrevious: 0,
      postsWithZeroEngagement: 0,
      bestPostUpvotes: 0,
      commentsReceivedTotal: 0
    };
  }

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recentDayPosts = posts.filter((p: any) => (p.timestamp || 0) > oneDayAgo);

  const recent = posts.slice(-5);
  const previous = posts.slice(-10, -5);

  const avgUpvotesRecent = recent.length > 0
    ? recent.reduce((sum: number, p: any) => sum + (p.upvotes || 0), 0) / recent.length
    : 0;

  const avgUpvotesPrevious = previous.length > 0
    ? previous.reduce((sum: number, p: any) => sum + (p.upvotes || 0), 0) / previous.length
    : 0;

  const postsWithZeroEngagement = recent.filter(
    (p: any) => (p.upvotes || 0) === 0 && (p.comments || 0) === 0
  ).length;

  const bestPostUpvotes = recent.reduce(
    (max: number, p: any) => Math.max(max, p.upvotes || 0), 0
  );

  const commentsReceivedTotal = recent.reduce(
    (sum: number, p: any) => sum + (p.comments || 0), 0
  );

  return {
    totalPostsLast24h: recentDayPosts.length,
    avgUpvotesRecent,
    avgUpvotesPrevious,
    postsWithZeroEngagement,
    bestPostUpvotes,
    commentsReceivedTotal
  };
}
