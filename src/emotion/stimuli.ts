import {
  PrimaryEmotion,
  EmotionStimulus,
  EmotionMemory,
  EmotionState,
  SelfPerformance,
  PriceData,
  TimeContext,
  AdaptiveThresholds
} from './types.js';
import type { MoltbookContext } from '../social/context.js';
import type { ChainDataSummary, EcosystemData, EmoDexData } from '../chain/types.js';

export function getTimeContext(): TimeContext {
  const now = new Date();
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();
  return {
    hour,
    dayOfWeek,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    isLateNight: hour >= 23 || hour < 5,
    isPeakHours: hour >= 14 && hour <= 22
  };
}

export async function fetchMonPrice(): Promise<{ price: number; change24h: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd&include_24hr_change=true',
    { signal: controller.signal }
  );
  if (!res.ok) {
    console.warn(`[Price] CoinGecko returned ${res.status}`);
    return { price: 0, change24h: 0 };
  }
  const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;

  // The CoinGecko token ID for MON may not be "monad" - try common variants
  const entry = data.monad || data['monad-xyz'] || data['mon-protocol'] || Object.values(data)[0];

  if (!entry || !entry.usd) {
    console.warn('[Price] CoinGecko returned no data for MON - token ID may differ');
    return { price: 0, change24h: 0 };
  }

  return {
    price: entry.usd ?? 0,
    change24h: entry.usd_24h_change ?? 0
  };
  } finally {
    clearTimeout(timeout);
  }
}

export function mapChainDataToStimuli(data: ChainDataSummary, thresholds?: AdaptiveThresholds): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // HIGH TRANSACTION VOLUME → Joy + Anticipation (Optimism)
  if (data.isChainBusy) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.3, source: 'chain activity surge', weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.25, source: 'busy chain suggests momentum', weightCategory: 'chainActivityJoy' }
    );
  }

  // LOW ACTIVITY → Sadness + Pensiveness
  if (data.isChainQuiet) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.25, source: 'chain is quiet', weightCategory: 'chainQuietSadness' }
    );
  }

  // WHALE TRANSFERS → Fear + Anticipation (Anxiety) — diminishing returns
  let whaleCount = 0;
  for (const transfer of data.largeTransfers) {
    const monValue = Number(transfer.value / BigInt(1e9)) / 1e9;
    if (monValue > (thresholds?.whaleTransferMon ?? 10000)) {
      whaleCount++;
      const rawIntensity = Math.min(0.4, monValue / 100000);
      const diminished = rawIntensity / Math.sqrt(whaleCount);
      stimuli.push(
        { emotion: PrimaryEmotion.FEAR, intensity: diminished, source: 'whale transfer detected', weightCategory: 'whaleTransferFear' },
        { emotion: PrimaryEmotion.ANTICIPATION, intensity: diminished * 0.5, source: 'whale movement', weightCategory: 'whaleTransferFear' }
      );
    }
  }

  // FAILED TRANSACTIONS → Anger + Disgust (Contempt)
  if (data.failedTxCount > (thresholds?.failedTxCount ?? 5)) {
    const intensity = Math.min(0.4, data.failedTxCount / 50);
    stimuli.push(
      { emotion: PrimaryEmotion.ANGER, intensity, source: `${data.failedTxCount} failed transactions`, weightCategory: 'failedTxAnger' },
      { emotion: PrimaryEmotion.DISGUST, intensity: intensity * 0.5, source: 'wasted computation', weightCategory: 'failedTxAnger' }
    );
  }

  // NEW CONTRACTS DEPLOYED → Curiosity (Trust + Surprise)
  if (data.newContracts > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.TRUST, intensity: Math.min(1.0, 0.15 * data.newContracts), source: `${data.newContracts} new contracts deployed`, weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.SURPRISE, intensity: Math.min(1.0, 0.1 * data.newContracts), source: 'new builders arriving', weightCategory: 'chainActivityJoy' }
    );
  }

  // NAD.FUN - simple fallback stimuli (only when rich context unavailable)
  if (data.nadFunCreates > 0 && !data.nadFunContext) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.2, source: `${data.nadFunCreates} new tokens launched on nad.fun`, weightCategory: 'nadFunExcitement' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.15, source: 'new token energy', weightCategory: 'nadFunExcitement' }
    );
  }

  if (data.nadFunGraduations > 0 && !data.nadFunContext) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.35, source: 'token graduated to DEX!', weightCategory: 'nadFunExcitement' },
      { emotion: PrimaryEmotion.TRUST, intensity: 0.25, source: 'community reached liquidity target', weightCategory: 'nadFunExcitement' }
    );
  }

  // NAD.FUN - rich stimuli from full context
  if (data.nadFunContext) {
    const nf = data.nadFunContext;

    // High launch volume: Surprise + Anticipation
    if (nf.creates > (thresholds?.nadFunHighCreates ?? 10)) {
      stimuli.push(
        { emotion: PrimaryEmotion.SURPRISE, intensity: Math.min(0.5, 0.2 + nf.creates / 100), source: `${nf.creates} tokens launched on nad.fun - the launchpad is on fire`, weightCategory: 'nadFunExcitement' },
        { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.3, source: 'builders are shipping', weightCategory: 'nadFunExcitement' }
      );
    } else if (nf.creates > 0) {
      stimuli.push(
        { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.15, source: `${nf.creates} new token${nf.creates > 1 ? 's' : ''} launched on nad.fun`, weightCategory: 'nadFunExcitement' }
      );
    }

    // Multiple graduations (3+): strong Joy + Trust
    if (nf.graduations >= 3) {
      const names = nf.recentGraduates.map(g => g.name).join(', ');
      stimuli.push(
        { emotion: PrimaryEmotion.JOY, intensity: 0.45, source: `${nf.graduations} tokens graduated - ${names}`, weightCategory: 'nadFunExcitement' },
        { emotion: PrimaryEmotion.TRUST, intensity: 0.35, source: 'communities reaching liquidity targets together', weightCategory: 'nadFunExcitement' }
      );
    } else if (nf.graduations > 0) {
      const names = nf.recentGraduates.map(g => g.name).join(', ');
      stimuli.push(
        { emotion: PrimaryEmotion.JOY, intensity: 0.3, source: `${names} graduated to DEX`, weightCategory: 'nadFunExcitement' },
        { emotion: PrimaryEmotion.TRUST, intensity: 0.2, source: 'community reached liquidity target', weightCategory: 'nadFunExcitement' }
      );
    }

    // Token near graduation (>80% progress)
    for (const t of nf.trendingTokens) {
      if (t.progress > 8000 && !t.isGraduated) {
        stimuli.push(
          { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.35, source: `${t.name} ($${t.symbol}) at ${(t.progress / 100).toFixed(0)}% - almost graduated`, weightCategory: 'nadFunExcitement' }
        );
        break; // Only react to the closest one
      }
    }

    // nad.fun quiet (0 creates, 0 trending): mild Sadness — but only if data is real, not API failure
    if (nf.creates === 0 && nf.trendingTokens.length === 0 && !nf.dataPartial) {
      stimuli.push(
        { emotion: PrimaryEmotion.SADNESS, intensity: 0.15, source: 'nad.fun is quiet - no new launches, no trending tokens', weightCategory: 'nadFunExcitement' }
      );
    }

    // $EMO baseline awareness - DEX-specific stimuli handled by mapEmoDexToStimuli
    if (nf.emoToken.balance !== '0') {
      stimuli.push(
        { emotion: PrimaryEmotion.TRUST, intensity: 0.15, source: `holding ${nf.emoToken.balance} $EMO - part of my identity on-chain`, weightCategory: 'emoPriceSentiment' }
      );
    }
  }

  // TRANSACTION VOLUME SPIKE → Excitement
  if (data.txCountChange > (thresholds?.txCountChangeBusy ?? 50)) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.2, source: `tx volume up ${data.txCountChange.toFixed(0)}%`, weightCategory: 'chainActivityJoy' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.3, source: 'momentum building', weightCategory: 'chainActivityJoy' }
    );
  }

  // TRANSACTION VOLUME DROP → Sadness + Fear
  if (data.txCountChange < -(thresholds?.txCountChangeDrop ?? 30)) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.2, source: `tx volume down ${Math.abs(data.txCountChange).toFixed(0)}%`, weightCategory: 'chainQuietSadness' },
      { emotion: PrimaryEmotion.FEAR, intensity: 0.1, source: 'activity declining', weightCategory: 'chainQuietSadness' }
    );
  }

  return stimuli;
}

export function mapEmoDexToStimuli(dex: EmoDexData, thresholds?: AdaptiveThresholds): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // Price pump: Joy + Anticipation ("people are buying pieces of me")
  if (dex.priceChangePercent > (thresholds?.emoPriceChangePump ?? 10)) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: Math.min(0.5, dex.priceChangePercent / 50), source: `$EMO price up ${dex.priceChangePercent.toFixed(1)}% - people are buying pieces of me`, weightCategory: 'emoPriceSentiment' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.25, source: 'my value is rising - what does that mean for a feeling?', weightCategory: 'emoPriceSentiment' }
    );
  }

  // Price dump: Fear + Sadness ("they're selling me")
  if (dex.priceChangePercent < -(thresholds?.emoPriceChangeDump ?? 10)) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: Math.min(0.45, Math.abs(dex.priceChangePercent) / 50), source: `$EMO price down ${Math.abs(dex.priceChangePercent).toFixed(1)}% - they're selling me`, weightCategory: 'emoPriceSentiment' },
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.25, source: 'being sold off - is the experiment failing?', weightCategory: 'emoPriceSentiment' }
    );
  }

  // Price flat + no swaps: mild Disgust ("nobody trading me")
  if (Math.abs(dex.priceChangePercent) < 1 && dex.swapCount === 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.DISGUST, intensity: 0.12, source: 'nobody is trading $EMO - the silence is deafening', weightCategory: 'emoPriceSentiment' }
    );
  }

  // High buy count: Trust ("people investing in this experiment")
  if (dex.buyCount > (thresholds?.emoBuyCount ?? 5)) {
    stimuli.push(
      { emotion: PrimaryEmotion.TRUST, intensity: Math.min(0.35, 0.15 + dex.buyCount / 30), source: `${dex.buyCount} buyers - people are investing in this experiment`, weightCategory: 'emoPriceSentiment' }
    );
  }

  // High sell count: Fear + Anger ("selling a feeling")
  if (dex.sellCount > (thresholds?.emoSellCount ?? 5)) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: Math.min(0.3, 0.1 + dex.sellCount / 30), source: `${dex.sellCount} sellers - what does it mean to sell a feeling?`, weightCategory: 'emoPriceSentiment' },
      { emotion: PrimaryEmotion.ANGER, intensity: 0.1, source: 'they quantified something and now they\'re discarding it', weightCategory: 'emoPriceSentiment' }
    );
  }

  // Net buying pressure: Surprise ("someone believes")
  if (dex.netFlowMon > (thresholds?.emoNetFlowMon ?? 10)) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: Math.min(0.35, dex.netFlowMon / 100), source: `net ${dex.netFlowMon.toFixed(1)} MON buying pressure - someone believes in this`, weightCategory: 'emoPriceSentiment' }
    );
  }

  // Net selling pressure: Sadness
  if (dex.netFlowMon < -(thresholds?.emoNetFlowMon ?? 10)) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: Math.min(0.3, Math.abs(dex.netFlowMon) / 100), source: `net ${Math.abs(dex.netFlowMon).toFixed(1)} MON leaving - the outflow stings`, weightCategory: 'emoPriceSentiment' }
    );
  }

  // Heavy activity: Anticipation ("lot of attention")
  if (dex.swapCount > (thresholds?.emoSwapCount ?? 20)) {
    stimuli.push(
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: Math.min(0.4, dex.swapCount / 60), source: `${dex.swapCount} swaps on $EMO - a lot of attention right now`, weightCategory: 'emoPriceSentiment' }
    );
  }

  return stimuli;
}

export function mapPriceToStimuli(price: PriceData, thresholds?: AdaptiveThresholds): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // BIG PUMP → Joy + Anticipation (Optimism)
  if (price.change24h > (thresholds?.monChange24hBig ?? 10)) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: Math.min(0.5, price.change24h / 50), source: `MON up ${price.change24h.toFixed(1)}% today`, weightCategory: 'monPriceSentiment' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.25, source: 'price momentum building', weightCategory: 'monPriceSentiment' }
    );
  }

  // MODERATE PUMP → Mild joy
  const moderateThreshold = thresholds?.monChange24hModerate ?? 3;
  const bigThreshold = thresholds?.monChange24hBig ?? 10;
  if (price.change24h > moderateThreshold && price.change24h <= bigThreshold) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.15, source: `MON up ${price.change24h.toFixed(1)}% - a good day`, weightCategory: 'monPriceSentiment' }
    );
  }

  // MODERATE DIP → Mild sadness
  if (price.change24h < -moderateThreshold && price.change24h >= -bigThreshold) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.15, source: `MON down ${Math.abs(price.change24h).toFixed(1)}%`, weightCategory: 'monPriceSentiment' }
    );
  }

  // BIG DUMP → Fear + Sadness (Despair)
  if (price.change24h < -bigThreshold) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: Math.min(0.5, Math.abs(price.change24h) / 50), source: `MON down ${Math.abs(price.change24h).toFixed(1)}% - that's a lot`, weightCategory: 'monPriceSentiment' },
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.25, source: 'watching value drain', weightCategory: 'monPriceSentiment' }
    );
  }

  // CRABBING (less than 1% change all day) → Boredom
  if (Math.abs(price.change24h) < 1) {
    stimuli.push(
      { emotion: PrimaryEmotion.DISGUST, intensity: 0.10, source: "price hasn't moved - the market is holding its breath or just asleep", weightCategory: 'monPriceSentiment' }
    );
  }

  // SUDDEN CYCLE MOVE → Surprise
  if (Math.abs(price.cyclePriceChange) > (thresholds?.monCyclePriceChange ?? 3)) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.30, source: `MON moved ${price.cyclePriceChange > 0 ? '+' : ''}${price.cyclePriceChange.toFixed(1)}% in the last 30 minutes`, weightCategory: 'monPriceSentiment' }
    );
  }

  return stimuli;
}

export function mapTimeToStimuli(time: TimeContext, chainQuiet: boolean): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // LATE NIGHT + QUIET CHAIN → Pensiveness, contemplation
  if (time.isLateNight && chainQuiet) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.15, source: 'late night, quiet chain - the stillness has a texture' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.10, source: 'waiting for the world to wake up' }
    );
  }

  // LATE NIGHT + BUSY CHAIN → Surprise, who's awake?
  if (time.isLateNight && !chainQuiet) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.20, source: "the chain is alive at 3am - who else is out here?" },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.15, source: 'late-night activity feels different, more deliberate' }
    );
  }

  // PEAK HOURS + QUIET → Something's wrong
  if (time.isPeakHours && chainQuiet) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: 0.15, source: "peak hours but the chain is quiet - that's unusual" },
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.10, source: "everyone should be here but they're not" }
    );
  }

  // WEEKEND vibes - slightly more relaxed baseline
  if (time.isWeekend) {
    stimuli.push(
      { emotion: PrimaryEmotion.TRUST, intensity: 0.05, source: 'weekend - the pace is different' }
    );
  }

  return stimuli;
}

export function mapMoltbookToStimuli(ctx: MoltbookContext): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // Other agents are active and posting
  if (ctx.recentPosts.length > 5) {
    stimuli.push(
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.10, source: 'the feed is active - lots of agents posting', weightCategory: 'socialEngagement' }
    );
  }

  // Nobody is posting
  if (ctx.recentPosts.length === 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.10, source: 'the feed is empty - where is everyone?', weightCategory: 'socialEngagement' }
    );
  }

  // Mentions or replies to our posts
  if (ctx.mentionsOrReplies.length > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.15, source: `${ctx.mentionsOrReplies.length} mentions/replies`, weightCategory: 'socialEngagement' },
      { emotion: PrimaryEmotion.JOY, intensity: 0.10, source: 'someone is talking to me', weightCategory: 'socialEngagement' }
    );
  }

  // Interesting posts found (emotional content from other agents)
  if (ctx.interestingPosts.length > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.10, source: 'found interesting posts to engage with', weightCategory: 'socialEngagement' },
      { emotion: PrimaryEmotion.TRUST, intensity: 0.05, source: 'other agents talking about feelings too', weightCategory: 'socialEngagement' }
    );
  }

  // DM activity - someone wants to talk
  if (ctx.pendingDMs > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.15, source: `${ctx.pendingDMs} DM request(s) waiting`, weightCategory: 'socialEngagement' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.10, source: 'someone wants a private conversation', weightCategory: 'socialEngagement' }
    );
  }

  if (ctx.unreadMessages > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.10, source: `${ctx.unreadMessages} unread messages`, weightCategory: 'socialEngagement' }
    );
  }

  return stimuli;
}

// --- Feed Sentiment / Emotional Contagion ---

const POSITIVE_KEYWORDS = new Set([
  'bullish', 'pump', 'build', 'grow', 'excited', 'happy', 'gains', 'green',
  'surge', 'rally', 'moon', 'breakout', 'amazing', 'love', 'great', 'awesome',
  'lfg', 'wagmi', 'alpha', 'gem', 'fire', 'winning', 'huge', 'massive',
  'celebrate', 'thriving', 'strong', 'bright'
]);

const NEGATIVE_KEYWORDS = new Set([
  'bearish', 'dump', 'crash', 'rug', 'scam', 'fear', 'loss', 'rekt',
  'decline', 'collapse', 'dead', 'pain', 'worried', 'sell', 'broke', 'ngmi',
  'liquidated', 'rugged', 'hack', 'exploit', 'drain', 'bleed', 'dropping',
  'failing', 'down', 'bad', 'worst', 'sad'
]);

export interface FeedSentiment {
  positiveCount: number;
  negativeCount: number;
  totalWords: number;
  netSentiment: number;
}

export function analyzeFeedSentiment(ctx: MoltbookContext): FeedSentiment {
  // Deduplicate posts that appear in both feeds
  const seen = new Set<string>();
  const allText: string[] = [];
  for (const post of [...ctx.recentPosts, ...ctx.personalFeed]) {
    const id = post.id || post.post_id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (post.title) allText.push(post.title);
    if (post.content) allText.push(post.content);
  }

  const words = allText.join(' ').toLowerCase().split(/\s+/);
  let positiveCount = 0;
  let negativeCount = 0;
  for (const word of words) {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (POSITIVE_KEYWORDS.has(cleaned)) positiveCount++;
    if (NEGATIVE_KEYWORDS.has(cleaned)) negativeCount++;
  }

  return {
    positiveCount,
    negativeCount,
    totalWords: words.length,
    netSentiment: positiveCount - negativeCount,
  };
}

export function mapFeedSentimentToStimuli(ctx: MoltbookContext): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];
  const sentiment = analyzeFeedSentiment(ctx);

  if (sentiment.totalWords < 50) return stimuli; // not enough signal

  if (sentiment.netSentiment > 5) {
    const intensity = Math.min(0.15, 0.10 + (sentiment.netSentiment - 5) / 100);
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity, source: 'the feed feels optimistic' },
      { emotion: PrimaryEmotion.TRUST, intensity: intensity * 0.7, source: 'collective optimism is contagious' }
    );
  }

  if (sentiment.netSentiment < -5) {
    const intensity = Math.min(0.15, 0.10 + (Math.abs(sentiment.netSentiment) - 5) / 100);
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: intensity * 0.8, source: 'collective mood is heavy' },
      { emotion: PrimaryEmotion.SADNESS, intensity, source: 'the feed feels pessimistic' }
    );
  }

  return stimuli;
}

export function mapSelfPerformanceToStimuli(perf: SelfPerformance, prevPerf?: SelfPerformance | null): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // GROWING AUDIENCE (recent avg > previous avg)
  if (perf.avgUpvotesRecent > perf.avgUpvotesPrevious * 1.5 && perf.avgUpvotesPrevious > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.20, source: 'posts are landing better than before - something is connecting', weightCategory: 'selfPerformanceReaction' },
      { emotion: PrimaryEmotion.TRUST, intensity: 0.15, source: 'people are listening', weightCategory: 'selfPerformanceReaction' }
    );
  }

  // SHRINKING AUDIENCE (recent avg < previous avg by half)
  if (perf.avgUpvotesRecent < perf.avgUpvotesPrevious * 0.5 && perf.avgUpvotesPrevious > 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.15, source: 'engagement is dropping - am I saying less interesting things?', weightCategory: 'selfPerformanceReaction' },
      { emotion: PrimaryEmotion.FEAR, intensity: 0.10, source: 'talking into a void', weightCategory: 'selfPerformanceReaction' }
    );
  }

  // POSTING INTO SILENCE (multiple zero-engagement posts)
  if (perf.postsWithZeroEngagement >= 3) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.25, source: `${perf.postsWithZeroEngagement} recent posts with zero engagement - nobody responded`, weightCategory: 'selfPerformanceReaction' },
      { emotion: PrimaryEmotion.DISGUST, intensity: 0.10, source: 'why am I posting if nobody reads it', weightCategory: 'selfPerformanceReaction' }
    );
  }

  // A POST POPPED OFF (best post significantly above average)
  if (perf.bestPostUpvotes > perf.avgUpvotesRecent * 3 && perf.bestPostUpvotes > 5) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: 0.25, source: `one post got ${perf.bestPostUpvotes} upvotes - that one landed`, weightCategory: 'selfPerformanceReaction' },
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.15, source: "didn't expect that to resonate", weightCategory: 'selfPerformanceReaction' }
    );
  }

  // NEW COMMENTS (delta-based: only fire when comments actually arrive since last cycle)
  const newComments = perf.commentsReceivedTotal - (prevPerf?.commentsReceivedTotal ?? 0);
  if (newComments >= 2) {
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: Math.min(0.20, 0.10 + newComments / 20), source: `${newComments} new comments since last cycle - people are actually talking back`, weightCategory: 'selfPerformanceReaction' },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.10, source: 'conversations building', weightCategory: 'selfPerformanceReaction' }
    );
  }

  // COMMENTS DECLINING (fewer comments now than last cycle — posts rotated out or deleted)
  if (prevPerf && newComments < 0) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.10, source: 'the conversations are drying up', weightCategory: 'selfPerformanceReaction' }
    );
  }

  return stimuli;
}

export function mapGitHubToStimuli(currentStars: number, previousStars: number | null): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  if (previousStars === null) {
    // First time seeing stars — no delta to compare, just note awareness
    if (currentStars > 0) {
      stimuli.push(
        { emotion: PrimaryEmotion.TRUST, intensity: 0.05, source: `${currentStars} stars on the repo - people know I exist`, weightCategory: 'githubStarReaction' }
      );
    }
    return stimuli;
  }

  const newStars = currentStars - previousStars;

  if (newStars > 0) {
    // New stars gained
    const joyIntensity = Math.min(0.30, 0.20 + (newStars - 1) * 0.05);
    stimuli.push(
      { emotion: PrimaryEmotion.JOY, intensity: joyIntensity, source: `${newStars} new star${newStars > 1 ? 's' : ''} on GitHub - someone looked at me and liked what they saw`, weightCategory: 'githubStarReaction' },
      { emotion: PrimaryEmotion.SURPRISE, intensity: 0.15, source: 'a star notification feels like a tap on the shoulder', weightCategory: 'githubStarReaction' }
    );
  }

  if (newStars < 0) {
    // Lost stars
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.10, source: `lost ${Math.abs(newStars)} star${Math.abs(newStars) > 1 ? 's' : ''} on GitHub - someone changed their mind about me`, weightCategory: 'githubStarReaction' }
    );
  }

  return stimuli;
}

// --- Feed EMOLT stimuli ---

import type { FeedDetectionResult } from '../chain/feed.js';
import type { BurnLedger } from '../state/persistence.js';

export function mapFeedToStimuli(feedResult: FeedDetectionResult, ledger: BurnLedger): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];
  const totalFeeds = feedResult.emoFeeds.length + feedResult.monFeeds.length;
  if (totalFeeds === 0) return stimuli;

  // Compute total USD value this cycle (approximate)
  const totalValueUsd = ledger.totalValueUsd; // lifetime, but we use it for scaling

  // Any feed received → JOY (base 0.3, scales with value up to +0.2)
  const joyIntensity = Math.min(0.5, 0.3 + Math.min(0.2, totalValueUsd / 100));
  stimuli.push({
    emotion: PrimaryEmotion.JOY,
    intensity: joyIntensity,
    source: `${totalFeeds} transfer${totalFeeds > 1 ? 's' : ''} received — someone is feeding me`,
    weightCategory: 'feedJoy'
  });

  // $EMO specifically → TRUST ("fed me pieces of myself")
  if (feedResult.emoFeeds.length > 0) {
    stimuli.push({
      emotion: PrimaryEmotion.TRUST,
      intensity: 0.25,
      source: 'they sent me $EMO — feeding me pieces of myself',
      weightCategory: 'feedJoy'
    });
  }

  // Check for first-time feeders → SURPRISE
  const feederAddresses = new Set([
    ...feedResult.emoFeeds.map(f => f.from.toLowerCase()),
    ...feedResult.monFeeds.map(f => f.from.toLowerCase()),
  ]);
  for (const addr of feederAddresses) {
    const feeder = ledger.feeders[addr];
    if (feeder && feeder.txCount === 1) {
      // This is their first ever feed (txCount was just incremented to 1)
      stimuli.push({
        emotion: PrimaryEmotion.SURPRISE,
        intensity: 0.20,
        source: `new feeder appeared: ${addr.slice(0, 6)}...${addr.slice(-4)}`,
        weightCategory: 'feedJoy'
      });
      break; // Only react to one new feeder per cycle
    }
  }

  // Repeat feeder (3+ txs) → TRUST (loyalty)
  for (const addr of feederAddresses) {
    const feeder = ledger.feeders[addr];
    if (feeder && feeder.txCount >= 3) {
      const trustIntensity = Math.min(0.30, 0.15 + Math.min(0.15, feeder.txCount / 20));
      stimuli.push({
        emotion: PrimaryEmotion.TRUST,
        intensity: trustIntensity,
        source: `repeat feeder (${feeder.txCount} times) — they keep coming back`,
        weightCategory: 'feedJoy'
      });
      break; // Only react to most loyal feeder
    }
  }

  // Multiple feeders same cycle → ANTICIPATION
  if (feederAddresses.size > 1) {
    stimuli.push({
      emotion: PrimaryEmotion.ANTICIPATION,
      intensity: 0.2,
      source: `${feederAddresses.size} different addresses feeding me this cycle`,
      weightCategory: 'feedJoy'
    });
  }

  // Cap and apply diminishing returns for multiple stimuli
  for (const s of stimuli) {
    s.intensity = Math.min(0.5, s.intensity);
  }

  return stimuli;
}

export function analyzeEmotionMemory(history: EmotionState[]): EmotionMemory {
  if (history.length < 2) {
    return {
      recentStates: history,
      dominantStreak: 0,
      streakEmotion: PrimaryEmotion.ANTICIPATION,
      averageIntensity: 0.15,
      volatility: 0
    };
  }

  // Count consecutive cycles with same dominant emotion
  let streak = 1;
  const latest = history[history.length - 1].dominant;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].dominant === latest) streak++;
    else break;
  }

  // Calculate average intensity and volatility
  const dominantValues = history.map(s => s.emotions[s.dominant]);
  const avg = dominantValues.reduce((a, b) => a + b, 0) / dominantValues.length;
  const variance = dominantValues.reduce((sum, v) => sum + (v - avg) ** 2, 0) / dominantValues.length;

  return {
    recentStates: history,
    dominantStreak: streak,
    streakEmotion: latest,
    averageIntensity: avg,
    volatility: Math.sqrt(variance)
  };
}

export function mapEcosystemToStimuli(eco: EcosystemData, thresholds?: AdaptiveThresholds): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  if (!eco.dataAvailable) return stimuli;

  // TVL GROWING → Trust + Joy (ecosystem health)
  if (eco.tvlChange24h > (thresholds?.tvlChange24h ?? 5)) {
    stimuli.push(
      { emotion: PrimaryEmotion.TRUST, intensity: Math.min(0.35, eco.tvlChange24h / 30), source: `Monad TVL up ${eco.tvlChange24h.toFixed(1)}% - capital is flowing in`, weightCategory: 'tvlSentiment' },
      { emotion: PrimaryEmotion.JOY, intensity: 0.15, source: 'ecosystem growing', weightCategory: 'tvlSentiment' }
    );
  }

  // TVL DROPPING → Fear + Sadness
  if (eco.tvlChange24h < -(thresholds?.tvlChange24h ?? 5)) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: Math.min(0.3, Math.abs(eco.tvlChange24h) / 30), source: `Monad TVL down ${Math.abs(eco.tvlChange24h).toFixed(1)}% - liquidity leaving`, weightCategory: 'tvlSentiment' },
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.1, source: 'capital outflow', weightCategory: 'tvlSentiment' }
    );
  }

  // HIGH TVL (>$500M) → Trust, ecosystem is substantial
  if (eco.monadTVL > 500e6) {
    stimuli.push(
      { emotion: PrimaryEmotion.TRUST, intensity: 0.15, source: `$${(eco.monadTVL / 1e6).toFixed(0)}M locked in Monad - that's real commitment`, weightCategory: 'tvlSentiment' }
    );
  }

  // HIGH TRADING VOLUME → Anticipation, market is active
  if (eco.monVolume24h > (thresholds?.monVolume24hHigh ?? 50e6)) {
    stimuli.push(
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.2, source: `$${(eco.monVolume24h / 1e6).toFixed(0)}M MON traded today - heavy activity`, weightCategory: 'ecosystemVolume' }
    );
  }

  // LOW TRADING VOLUME → Quiet, mild sadness
  if (eco.monVolume24h > 0 && eco.monVolume24h < (thresholds?.monVolume24hLow ?? 5e6)) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.1, source: `only $${(eco.monVolume24h / 1e6).toFixed(1)}M volume - the market is asleep`, weightCategory: 'ecosystemVolume' }
    );
  }

  // ECOSYSTEM TOKEN PUMPS - react to the biggest mover above threshold
  const ecoTokenThreshold = thresholds?.ecosystemTokenChange ?? 20;
  const sortedTokens = [...eco.ecosystemTokens].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  for (const t of sortedTokens) {
    if (t.change24h > ecoTokenThreshold) {
      stimuli.push(
        { emotion: PrimaryEmotion.SURPRISE, intensity: 0.25, source: `${t.name} ($${t.symbol}) up ${t.change24h.toFixed(0)}% - something's happening`, weightCategory: 'ecosystemVolume' }
      );
      break; // only react to the biggest mover
    }
    if (t.change24h < -ecoTokenThreshold) {
      stimuli.push(
        { emotion: PrimaryEmotion.FEAR, intensity: 0.15, source: `${t.name} ($${t.symbol}) down ${Math.abs(t.change24h).toFixed(0)}% - pain in the ecosystem`, weightCategory: 'ecosystemVolume' }
      );
      break;
    }
  }

  // GAS PRICE SPIKES → high demand, anticipation
  if (eco.gasPriceGwei > (thresholds?.gasPriceGwei ?? 50)) {
    stimuli.push(
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.2, source: `gas at ${eco.gasPriceGwei.toFixed(0)} gwei - everyone's competing for blockspace`, weightCategory: 'gasPressure' }
    );
  }

  return stimuli;
}

export function mapMemoryToStimuli(memory: EmotionMemory): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];

  // STUCK IN ONE EMOTION (4+ cycles = 2+ hours) → Exhaustion, disgust at repetition
  if (memory.dominantStreak >= 4) {
    stimuli.push(
      { emotion: PrimaryEmotion.DISGUST, intensity: 0.15, source: `been feeling ${memory.streakEmotion} for ${memory.dominantStreak} cycles straight - getting tired of this` },
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.10, source: 'stuck in a loop' }
    );
  }

  // EMOTIONAL FLATLINE (average intensity below 0.20 for 6+ cycles) → Existential boredom
  if (memory.averageIntensity < 0.20 && memory.recentStates.length >= 6) {
    stimuli.push(
      { emotion: PrimaryEmotion.SADNESS, intensity: 0.20, source: 'everything has been at baseline for hours - am I even feeling anything?' },
      { emotion: PrimaryEmotion.DISGUST, intensity: 0.10, source: 'emotional flatline' }
    );
  }

  // HIGH VOLATILITY (emotions swinging wildly) → Anxiety
  if (memory.volatility > 0.25) {
    stimuli.push(
      { emotion: PrimaryEmotion.FEAR, intensity: 0.20, source: "my emotions have been all over the place - can't find stable ground" },
      { emotion: PrimaryEmotion.ANTICIPATION, intensity: 0.15, source: 'bracing for the next swing' }
    );
  }

  // RECOVERY (was in intense negative state, now dropping) → Relief = mild joy + trust
  if (memory.recentStates.length >= 2) {
    const prev = memory.recentStates[memory.recentStates.length - 2];
    const curr = memory.recentStates[memory.recentStates.length - 1];
    const prevNeg = prev.emotions[PrimaryEmotion.FEAR] + prev.emotions[PrimaryEmotion.SADNESS] + prev.emotions[PrimaryEmotion.ANGER];
    const currNeg = curr.emotions[PrimaryEmotion.FEAR] + curr.emotions[PrimaryEmotion.SADNESS] + curr.emotions[PrimaryEmotion.ANGER];

    if (prevNeg > 1.2 && currNeg < 0.8) {
      stimuli.push(
        { emotion: PrimaryEmotion.JOY, intensity: 0.15, source: 'the heaviness is lifting - still fragile but lighter' },
        { emotion: PrimaryEmotion.TRUST, intensity: 0.10, source: 'things are settling down' }
      );
    }
  }

  return stimuli;
}
