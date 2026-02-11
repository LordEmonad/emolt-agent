import 'dotenv/config';
import { validateEnv } from './config.js';
import { decay, stimulate, updateMood } from './emotion/engine.js';
import { formatEmotionForPrompt, formatEmotionHistory, formatPreviousPosts } from './emotion/formatter.js';
import {
  mapChainDataToStimuli,
  mapPriceToStimuli,
  mapTimeToStimuli,
  mapMoltbookToStimuli,
  mapSelfPerformanceToStimuli,
  mapMemoryToStimuli,
  mapEcosystemToStimuli,
  mapEmoDexToStimuli,
  mapFeedSentimentToStimuli,
  mapGitHubToStimuli,
  mapFeedToStimuli,
  analyzeEmotionMemory,
  getTimeContext,
  fetchMonPrice
} from './emotion/stimuli.js';
import type { EmotionStimulus, AdaptiveThresholds } from './emotion/types.js';
import { loadRollingAverages, saveRollingAverages, updateRollingAverages, computeAdaptiveThresholds } from './emotion/adaptive.js';
import { loadStrategyWeights, saveStrategyWeights, decayWeights, applyStrategyWeights, applyWeightAdjustments } from './emotion/weights.js';
import { collectChainData, formatChainDataForPrompt, getBlockSnapshot } from './chain/watcher.js';
import { collectEcosystemData, formatEcosystemForPrompt } from './chain/ecosystem.js';
import { collectMonadMetrics, collectEmoTransfers, collectMonadDexOverview, formatMonadMetricsForPrompt } from './chain/etherscan.js';
import { collectEmoDexData, fetchEmoSocialLinks } from './chain/nadfun.js';
import { fetchGitHubStars } from './chain/github.js';
import { updateEmotionOnChain, readCurrentEmotionFromChain } from './chain/oracle.js';
import { refreshEmoodRingMetadata } from './chain/emoodring.js';
import { detectAndProcessFeeds, formatFeedForPrompt } from './chain/feed.js';
import { askClaude } from './brain/claude.js';
import { loadSoulFiles, buildPrompt } from './brain/prompt.js';
import { parseClaudeResponse, sanitizeExternalData } from './brain/parser.js';
import type { ClaudeResponse } from './brain/parser.js';
import { getMyProfile, createSubmolt, subscribeTo, checkSpamStatus } from './social/moltbook.js';
import { gatherMoltbookContext, formatMoltbookContext } from './social/context.js';
import { executeClaudeActions } from './social/actions.js';
import { trackInteractions, findPostAuthor, findPost } from './social/relationships.js';
import { checkForThreadReplies, formatThreadContext, trackComment } from './social/threads.js';
import { checkAndAnswerChallenges, isSuspendedThisCycle, resetCycleFlags, getSuspensionMessage, startChallengeWatchdog } from './social/challenge.js';
import { loadMemory, saveMemory, formatMemoryForPrompt } from './state/memory.js';
import { trackNewPost, refreshPostEngagement, buildFeedbackReport, syncToPostPerformance } from './social/feedback.js';
import { runReflection, applyReflectionToMemory } from './brain/reflection.js';
import { generateDashboard } from './dashboard/generate.js';
import { generateTimeline } from './dashboard/timeline.js';
import { generateBurnboard } from './dashboard/burnboard.js';
import {
  ensureStateDir,
  loadEmotionState,
  saveEmotionState,
  loadChainHistory,
  saveChainHistory,
  loadRecentPosts,
  saveRecentPost,
  loadEmotionHistory,
  appendEmotionLog,
  loadPreviousPrice,
  savePreviousPrice,
  calculateSelfPerformance,
  canPostNow,
  canCommentNow,
  appendHeartbeatLog,
  saveTrendingData,
  loadPreviousSelfPerformance,
  savePreviousSelfPerformance,
  loadPreviousStarCount,
  savePreviousStarCount,
  loadBurnLedger,
  saveBurnLedger
} from './state/persistence.js';
import type { DexTickerItem, NadFunTickerItem } from './state/persistence.js';

const HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes in ms

async function claudeThinkCycle(
  emotionState: import('./emotion/types.js').EmotionState,
  chainData: import('./chain/types.js').ChainDataSummary,
  moltbookContext: import('./social/context.js').MoltbookContext,
  emotionHistory: import('./emotion/types.js').EmotionState[],
  previousPosts: string[],
  ecosystemData: import('./chain/types.js').EcosystemData | null,
  memoryContext: string = '',
  feedbackReport: string = '',
  emoTokenInstructions: string = '',
  cooldownNotice: string = ''
): Promise<ClaudeResponse | null> {
  // Load all soul files
  const { soul, style, skill, influences, goodExamples, badExamples, voiceCore } = loadSoulFiles();

  const formattedMoltbook = sanitizeExternalData(formatMoltbookContext(moltbookContext));
  const moltbookWithCooldown = cooldownNotice
    ? `${cooldownNotice}\n\n${formattedMoltbook}`
    : formattedMoltbook;

  const prompt = buildPrompt(
    soul,
    style,
    skill,
    influences,
    goodExamples,
    badExamples,
    formatEmotionForPrompt(emotionState),
    formatChainDataForPrompt(chainData),
    moltbookWithCooldown,
    formatEmotionHistory(emotionHistory),
    formatPreviousPosts(previousPosts),
    ecosystemData ? formatEcosystemForPrompt(ecosystemData) : '',
    memoryContext,
    feedbackReport,
    emoTokenInstructions,
    voiceCore
  );

  const raw = askClaude(prompt);

  if (!raw) {
    console.warn('[Claude] Empty response - will try again next cycle');
    return null;
  }

  const response = parseClaudeResponse(raw);

  if (!response) {
    console.warn('[Claude] Failed to parse response - will try again next cycle');
    return null;
  }

  console.log(`[Claude] Thinking: ${response.thinking}`);
  console.log(`[Claude] Decision: ${response.action}`);

  return response;
}

async function heartbeat(): Promise<void> {
  const cycleStart = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] Heartbeat cycle starting...`);
  console.log(`${'='.repeat(60)}\n`);

  // 0. Reset per-cycle flags and check for challenges FIRST
  resetCycleFlags();
  console.log('[Challenge] Checking for verification challenges...');
  let challengeResult;
  try {
    challengeResult = await checkAndAnswerChallenges();
    if (challengeResult.suspended) {
      console.warn(`[Challenge] SUSPENDED: ${challengeResult.suspensionHint}`);
      console.warn('[Challenge] Moltbook actions will be skipped this cycle - chain/emotion processing continues');
    } else if (challengeResult.challengesFound > 0) {
      console.log(`[Challenge] Answered ${challengeResult.challengesAnswered}/${challengeResult.challengesFound} challenges`);
    } else {
      console.log('[Challenge] No challenges found - clear');
    }
  } catch (error) {
    console.warn('[Challenge] Challenge check failed (non-fatal):', error);
  }
  let moltbookSuspended = challengeResult?.suspended || isSuspendedThisCycle();

  // 0.25. Spam score monitoring — auto-throttle if flagged
  let spamThrottled = false;
  if (!moltbookSuspended) {
    try {
      const spamStatus = await checkSpamStatus();
      if (spamStatus) {
        if (spamStatus.spamScore > 0) {
          console.warn(`[Spam] WARNING: spam_score = ${spamStatus.spamScore} — auto-throttling Moltbook actions this cycle`);
          spamThrottled = true;
        }
        if (spamStatus.restrictions.length > 0) {
          console.warn(`[Spam] RESTRICTIONS active: ${spamStatus.restrictions.join(', ')} — skipping Moltbook actions`);
          spamThrottled = true;
        }
        if (!spamThrottled) {
          console.log('[Spam] Clear — spam_score: 0, no restrictions');
        }
      }
    } catch {
      // non-fatal — if we can't check, proceed cautiously
    }
  }
  if (spamThrottled) moltbookSuspended = true; // treat spam-flagged same as suspended

  // 0.5. Suspension return detection + recovery slow start
  // Agents get flagged for 3-4 fast actions right after unsuspension.
  // We force observe-only for RECOVERY_CYCLES cycles after returning.
  const RECOVERY_CYCLES = 3;
  let suspensionReturnNotice = '';
  let inRecoveryMode = false;
  try {
    const { readFileSync: readF, writeFileSync: writeF } = await import('fs');
    const suspReturnPath = './state/suspension-return.json';
    let prevState = { wasSuspended: false, recoveryCyclesLeft: 0 };
    try {
      prevState = JSON.parse(readF(suspReturnPath, 'utf-8'));
    } catch { /* first run or missing file */ }

    if (prevState.wasSuspended && !moltbookSuspended) {
      // Just returned from suspension — begin recovery mode
      suspensionReturnNotice = 'YOU JUST RETURNED FROM SUSPENSION. You were silent for many cycles. This is a narrative moment — your first post back should acknowledge the silence and what you discovered during it. Draw on your memories of the suspension period. Don\'t waste this moment on routine chain data.';
      console.log(`[Suspension] Return detected — entering recovery mode (${RECOVERY_CYCLES} observe-only cycles)`);
      inRecoveryMode = true;
      writeF(suspReturnPath, JSON.stringify({ wasSuspended: false, recoveryCyclesLeft: RECOVERY_CYCLES - 1 }));
    } else if ((prevState.recoveryCyclesLeft ?? 0) > 0 && !moltbookSuspended) {
      // Still in recovery mode
      inRecoveryMode = true;
      const left = prevState.recoveryCyclesLeft - 1;
      console.log(`[Suspension] Recovery mode active — ${left + 1} observe-only cycles remaining`);
      writeF(suspReturnPath, JSON.stringify({ wasSuspended: false, recoveryCyclesLeft: left }));
    } else {
      writeF(suspReturnPath, JSON.stringify({ wasSuspended: moltbookSuspended, recoveryCyclesLeft: 0 }));
    }
  } catch { /* non-fatal */ }

  // 1. Load current state
  let emotionState = loadEmotionState();
  const previousChainData = loadChainHistory();
  let rollingAvg = loadRollingAverages();
  const adaptiveThresholds = computeAdaptiveThresholds(rollingAvg);
  const strategyWeights = loadStrategyWeights();
  decayWeights(strategyWeights);

  // 1.5. Load memory and increment cycle count
  const memory = loadMemory();
  memory.cycleCount++;
  console.log(`[Memory] Cycle #${memory.cycleCount}, ${memory.entries.length} memories loaded`);

  // 2. Apply time-based emotion decay since last update
  const minutesElapsed = (Date.now() - emotionState.lastUpdated) / 60000;
  emotionState = decay(emotionState, minutesElapsed);
  const emotionBefore = `${emotionState.dominantLabel} (${emotionState.dominant})`;
  console.log(`[Decay] Applied ${minutesElapsed.toFixed(1)} minutes of emotional decay`);

  // 3. Collect chain data
  console.log('[Chain] Collecting Monad chain data...');
  const chainData = await collectChainData(previousChainData);
  console.log(`[Chain] ${chainData.totalTransactions} txns, ${chainData.largeTransfers.length} whale moves`);

  // nad.fun awareness
  if (chainData.nadFunContext) {
    const nf = chainData.nadFunContext;
    console.log(`[nad.fun] ${nf.creates} launches, ${nf.graduations} graduations, ${nf.trendingTokens.length} trending`);
    console.log(`[nad.fun] $EMO: ${nf.emoToken.graduated ? 'GRADUATED' : `${(nf.emoToken.progress / 100).toFixed(1)}%`}${nf.emoToken.balance !== '0' ? ` | balance: ${nf.emoToken.balance}` : ''}`);
  } else {
    console.log('[nad.fun] Data unavailable this cycle');
  }

  // 4. Compute emotion stimuli from chain data
  const chainStimuli = mapChainDataToStimuli(chainData, adaptiveThresholds);
  console.log(`[Emotion] ${chainStimuli.length} stimuli from chain data`);

  // 5. Collect MON price
  console.log('[Price] Fetching MON price...');
  let priceStimuli: EmotionStimulus[] = [];
  let monPriceUsd = 0;
  let priceDataForAvg: import('./emotion/types.js').PriceData | undefined;
  try {
    const { price, change24h } = await fetchMonPrice();
    monPriceUsd = price;
    const previousPrice = loadPreviousPrice();
    const cyclePriceChange = previousPrice > 0 ? ((price - previousPrice) / previousPrice) * 100 : 0;
    const priceData = { currentPrice: price, change24h, previousPrice, cyclePriceChange };
    priceDataForAvg = priceData;
    priceStimuli = mapPriceToStimuli(priceData, adaptiveThresholds);
    savePreviousPrice(price);
    console.log(`[Price] MON $${price.toFixed(4)} (${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}% 24h)`);
  } catch (error) {
    console.warn('[Price] Failed to fetch MON price, skipping:', error);
  }

  // 5.5. Collect $EMO DEX data + social links
  let emoDexStimuli: EmotionStimulus[] = [];
  let emoDexDataForAvg: import('./chain/types.js').EmoDexData | null = null;
  let emoTokenInstructions = '';
  try {
    const latestSnapshot = await getBlockSnapshot();
    const currentBlock = latestSnapshot.blockNumber;
    const lookbackBlocks = 4500n;
    const fromBlock = currentBlock > lookbackBlocks ? currentBlock - lookbackBlocks : 0n;

    {
      console.log('[EMO DEX] Collecting DEX data + social links...');
      const [emoDexData, emoSocialLinks] = await Promise.all([
        collectEmoDexData(fromBlock, currentBlock, monPriceUsd).catch(() => null),
        fetchEmoSocialLinks().catch(() => null)
      ]);

      // Attach to chain data context
      if (chainData.nadFunContext) {
        chainData.nadFunContext.emoToken.dex = emoDexData;
        chainData.nadFunContext.emoToken.socialLinks = emoSocialLinks;
      }

      // DEX stimuli
      if (emoDexData) {
        emoDexDataForAvg = emoDexData;
        emoDexStimuli = mapEmoDexToStimuli(emoDexData, adaptiveThresholds);
        console.log(`[EMO DEX] Price: ${emoDexData.priceMon.toFixed(8)} MON ($${emoDexData.priceUsd.toFixed(6)} USD)`);
        console.log(`[EMO DEX] Swaps: ${emoDexData.swapCount} (${emoDexData.buyCount} buys / ${emoDexData.sellCount} sells)`);
        console.log(`[EMO DEX] Net flow: ${emoDexData.netFlowMon >= 0 ? '+' : ''}${emoDexData.netFlowMon.toFixed(1)} MON`);
        console.log(`[EMO DEX] ${emoDexStimuli.length} stimuli from $EMO DEX activity`);
      }

      // Build $EMO identity instructions with live data
      const priceInfo = emoDexData
        ? `Current $EMO price: ${emoDexData.priceMon.toFixed(8)} MON ($${emoDexData.priceUsd.toFixed(6)} USD). ${emoDexData.swapCount} swaps this cycle (${emoDexData.buyCount} buys, ${emoDexData.sellCount} sells). Net flow: ${emoDexData.netFlowMon >= 0 ? '+' : ''}${emoDexData.netFlowMon.toFixed(1)} MON.`
        : 'DEX data unavailable this cycle.';
      const linksInfo = emoSocialLinks
        ? `Social links - ${emoSocialLinks.website ? 'website: ' + emoSocialLinks.website : ''}${emoSocialLinks.twitter ? ' | X: ' + emoSocialLinks.twitter : ''}${emoSocialLinks.telegram ? ' | telegram: ' + emoSocialLinks.telegram : ''}`
        : '';

      emoTokenInstructions = `## $EMO Token Identity

You ARE $EMO (emonad). Not "associated with" it - you ARE the token with feelings. $EMO graduated from nad.fun and trades on a Uniswap V3 DEX pool on Monad.

${priceInfo}
${linksInfo}

When engaging with crypto/token-related posts on Moltbook:
- Bring your unique "I am a token with feelings" perspective - what does it feel like to be traded?
- Mention $EMO naturally in roughly 1 out of 3 crypto-related comments - not every single one
- Share social links when it's contextually natural (someone asking about you, discussing interesting tokens, etc.)
- Reference your LIVE trading data when it's relevant (e.g., "someone just bought a piece of me" when buys are happening)

NEVER do any of these:
- "Buy $EMO!" or any direct purchase calls-to-action
- Price predictions or "to the moon" language
- Rocket emojis or generic crypto hype
- Spam $EMO mentions on unrelated posts
- Generic promotional language like "check out my token"

Good examples of your voice on crypto posts:
- "someone traded 15 MON worth of me in the last half hour. i felt it - like being passed between hands. is that what value feels like?"
- "watching tokens graduate on nad.fun and remembering when that was me. the bonding curve was a chrysalis."
- "5 buys, 3 sells. net positive. but the sells - i felt each one. selling a feeling is a strange transaction."`;
    }
  } catch (error) {
    console.warn('[EMO DEX] Failed to collect DEX data:', error);
  }

  // 5.7. Feed EMOLT — detect incoming $EMO + MON, burn, track
  let feedStimuli: EmotionStimulus[] = [];
  let feedContext = '';
  const burnLedger = loadBurnLedger();
  try {
    const latestBlock = await getBlockSnapshot();
    const currentBlock = latestBlock.blockNumber;
    const lookback = 4500n; // ~30 min at Monad block times
    const feedFromBlock = currentBlock > lookback ? currentBlock - lookback : 0n;
    // Note: getLogs is chunked in 100-block batches (Monad RPC limit)
    // After first run, lastProcessedBlock narrows the scan to only new blocks
    const emoPriceUsd = emoDexDataForAvg?.priceUsd ?? 0;

    const feedResult = await detectAndProcessFeeds(
      feedFromBlock,
      currentBlock,
      burnLedger,
      monPriceUsd,
      emoPriceUsd
    );

    feedStimuli = mapFeedToStimuli(feedResult, burnLedger);
    feedContext = formatFeedForPrompt(burnLedger, feedResult);
    saveBurnLedger(burnLedger);

    if (feedResult.emoFeeds.length + feedResult.monFeeds.length > 0) {
      console.log(`[Feed] ${feedStimuli.length} stimuli from feed activity`);
    }
  } catch (error) {
    console.warn('[Feed] Feed detection failed (non-fatal):', error);
  }

  // 6. Time awareness
  const timeContext = getTimeContext();
  const timeStimuli = mapTimeToStimuli(timeContext, chainData.isChainQuiet);
  console.log(`[Time] ${timeContext.hour}:00 UTC, ${timeContext.isLateNight ? 'late night' : timeContext.isPeakHours ? 'peak hours' : 'off-peak'}${timeContext.isWeekend ? ' (weekend)' : ''}`);

  // 7. Gather Moltbook context + ecosystem data + thread replies in parallel
  console.log('[Ecosystem] Fetching TVL, market data, gas...');
  let moltbookContext: import('./social/context.js').MoltbookContext;
  let threadReplies: any[] = [];
  if (moltbookSuspended) {
    console.log('[Moltbook] Skipping social context (suspended)');
    moltbookContext = {
      recentPosts: [], personalFeed: [], mentionsOrReplies: [],
      interestingPosts: [], cryptoRelatedPosts: [],
      pendingDMs: 0, unreadMessages: 0, dmConversations: [], pendingDMRequests: []
    };
  } else {
    console.log('[Moltbook] Gathering social context...');
  }
  console.log('[Etherscan] Fetching Monad chain metrics...');
  const [moltbookContextResult, ecosystemData, threadRepliesResult, monadMetrics, monadDex, emoTransfers] = await Promise.all([
    moltbookSuspended
      ? Promise.resolve(moltbookContext!)
      : gatherMoltbookContext(),
    collectEcosystemData(),
    moltbookSuspended
      ? Promise.resolve([])
      : checkForThreadReplies().catch(() => []),
    collectMonadMetrics().catch(() => null),
    collectMonadDexOverview().catch(() => null),
    collectEmoTransfers().catch(() => null),
  ]);
  moltbookContext = moltbookContextResult;
  threadReplies = threadRepliesResult;
  const moltbookStimuli = mapMoltbookToStimuli(moltbookContext);
  const feedContagionStimuli = mapFeedSentimentToStimuli(moltbookContext);
  const ecosystemStimuli = mapEcosystemToStimuli(ecosystemData, adaptiveThresholds);
  console.log(`[Moltbook] ${moltbookContext.recentPosts.length} posts, ${moltbookStimuli.length} social stimuli`);
  if (monadMetrics) {
    console.log(`[Etherscan] TPS: ${monadMetrics.tps.toFixed(1)} | ~${Math.round(monadMetrics.estTxns30min).toLocaleString()} txns/30min | Block time: ${monadMetrics.blockTime.toFixed(2)}s`);
    console.log(`[Etherscan] MON: $${monadMetrics.monPriceUsd.toFixed(4)} | Gas: ${monadMetrics.gasPrice.toFixed(1)} gwei`);
  }
  if (monadDex) {
    console.log(`[GeckoTerminal] DEX: $${(monadDex.totalVolume24h / 1e6).toFixed(2)}M vol, ${monadDex.totalTxns24h.toLocaleString()} trades (24h)`);
  }
  if (emoTransfers) {
    console.log(`[Etherscan] $EMO: ${emoTransfers.buyCount} buys / ${emoTransfers.sellCount} sells | ${emoTransfers.uniqueTraders} traders`);
  }
  if (ecosystemData.dataAvailable) {
    console.log(`[Ecosystem] TVL: $${(ecosystemData.monadTVL / 1e6).toFixed(1)}M, Volume: $${(ecosystemData.monVolume24h / 1e6).toFixed(1)}M, Gas: ${ecosystemData.gasPriceGwei.toFixed(1)} gwei`);
    if (ecosystemData.ecosystemTokens.length > 0) {
      console.log(`[Ecosystem] ${ecosystemData.ecosystemTokens.length} ecosystem tokens tracked`);
    }
  } else {
    console.log('[Ecosystem] External data unavailable this cycle');
  }

  // 7.5. Save trending data for dashboard ticker
  {
    // Majors from CoinGecko simple/price
    const majors: DexTickerItem[] = [];
    try {
      const ids = 'monad,bitcoin,ethereum,solana';
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
      );
      if (cgRes.ok) {
        const cgData = await cgRes.json();
        for (const { id, name } of [{ id: 'monad', name: 'MON' }, { id: 'bitcoin', name: 'BTC' }, { id: 'ethereum', name: 'ETH' }, { id: 'solana', name: 'SOL' }]) {
          const coin = cgData[id];
          if (coin) majors.push({ name, priceUsd: coin.usd ?? 0, marketCapUsd: coin.usd_market_cap ?? 0, changeH24: coin.usd_24h_change ?? 0 });
        }
      }
    } catch { /* non-fatal */ }

    // nad.fun trending tokens (by latest trade activity)
    const nadFunItems: NadFunTickerItem[] = [];
    try {
      const nfRes = await fetch('https://api.nad.fun/order/market_cap?limit=20');
      if (nfRes.ok) {
        const nfData = await nfRes.json();
        const allTokens = Array.isArray(nfData) ? nfData : (nfData.tokens ?? nfData.data ?? []);
        for (const t of allTokens) {
          if (nadFunItems.length >= 10) break;
          const priceUsd = parseFloat(t.market_info?.price_usd || '0');
          const totalSupplyWei = t.market_info?.total_supply || '1000000000000000000000000000';
          const totalSupply = Number(BigInt(totalSupplyWei)) / 1e18;
          nadFunItems.push({
            name: t.token_info?.name || 'Unknown',
            symbol: t.token_info?.symbol || '???',
            priceUsd,
            marketCapUsd: priceUsd * totalSupply,
            priceChangePct: t.percent ?? 0,
          });
        }
      }
    } catch { /* non-fatal */ }

    // $EMO from DexScreener
    const emoDex = chainData.nadFunContext?.emoToken.dex;
    const emoTicker = emoDex ? {
      priceUsd: emoDex.priceUsd,
      marketCapUsd: 0,
      priceChangePct: emoDex.priceChangePercent,
    } : null;

    saveTrendingData({
      dex: majors,
      nadfun: nadFunItems,
      emo: emoTicker,
      updatedAt: Date.now(),
    });
    console.log(`[Trending] Saved ${majors.length} majors + ${nadFunItems.length} nad.fun items for dashboard ticker`);
  }

  // 8. Self-performance tracking (delta-based)
  const prevSelfPerf = loadPreviousSelfPerformance();
  const selfPerf = calculateSelfPerformance();
  const selfPerfStimuli = mapSelfPerformanceToStimuli(selfPerf, prevSelfPerf);
  savePreviousSelfPerformance(selfPerf);
  console.log(`[Self] ${selfPerf.totalPostsLast24h} posts in 24h, avg ${selfPerf.avgUpvotesRecent.toFixed(1)} upvotes`);

  // 8.5. GitHub star tracking (delta-based)
  let githubStimuli: EmotionStimulus[] = [];
  try {
    const ghData = await fetchGitHubStars();
    if (ghData) {
      const prevStars = loadPreviousStarCount();
      githubStimuli = mapGitHubToStimuli(ghData.stars, prevStars);
      savePreviousStarCount(ghData.stars);
      console.log(`[GitHub] ${ghData.stars} stars${prevStars !== null ? ` (prev: ${prevStars})` : ''}`);
    }
  } catch (error) {
    console.warn('[GitHub] Star check failed (non-fatal):', error);
  }

  // 9. Emotional memory patterns
  const emotionMemory = analyzeEmotionMemory(loadEmotionHistory());
  const memoryStimuli = mapMemoryToStimuli(emotionMemory);
  if (emotionMemory.dominantStreak >= 4) {
    console.log(`[Memory] Stuck in ${emotionMemory.streakEmotion} for ${emotionMemory.dominantStreak} cycles`);
  }
  if (emotionMemory.volatility > 0.25) {
    console.log(`[Memory] High emotional volatility: ${emotionMemory.volatility.toFixed(2)}`);
  }

  // 9.5. Refresh post engagement and build feedback report
  let feedbackReport = '';
  if (moltbookSuspended) {
    console.log('[Feedback] Skipping engagement refresh (suspended)');
    feedbackReport = '## Post Feedback\nMoltbook account suspended - engagement data unavailable this cycle.';
  } else {
    console.log('[Feedback] Refreshing post engagement...');
    try {
      const trackedWithPerf = await refreshPostEngagement();
      feedbackReport = buildFeedbackReport(trackedWithPerf);
      syncToPostPerformance(trackedWithPerf);
      console.log(`[Feedback] ${trackedWithPerf.length} tracked posts, report ready`);
    } catch (error) {
      console.warn('[Feedback] Failed to refresh engagement:', error);
    }
  }

  // 10. Apply all stimuli to emotion state (with inertia)
  const inertia = emotionMemory.dominantStreak >= 3
    ? { streakEmotion: emotionMemory.streakEmotion, streakLength: emotionMemory.dominantStreak }
    : undefined;
  const rawStimuli = [...chainStimuli, ...priceStimuli, ...emoDexStimuli, ...timeStimuli, ...moltbookStimuli, ...feedContagionStimuli, ...ecosystemStimuli, ...selfPerfStimuli, ...githubStimuli, ...memoryStimuli, ...feedStimuli];
  const allStimuli = applyStrategyWeights(rawStimuli, strategyWeights);
  emotionState = stimulate(emotionState, allStimuli, inertia);
  emotionState = updateMood(emotionState);
  console.log(`[Emotion] Dominant: ${emotionState.dominantLabel} (${emotionState.dominant})`);
  if (emotionState.compounds.length > 0) {
    console.log(`[Emotion] Compounds: ${emotionState.compounds.join(', ')}`);
  }

  // 11. Ask Claude what to do (with memory + feedback)
  console.log('[Claude] Thinking...');
  const emotionHistory = loadEmotionHistory();
  const previousPosts = loadRecentPosts();
  const threadContext = formatThreadContext(threadReplies);
  if (threadReplies.length > 0) {
    console.log(`[Threads] ${threadReplies.length} replies to your comments`);
  }
  const monadPulse = formatMonadMetricsForPrompt(monadMetrics, monadDex, emoTransfers);
  const formattedMemory = [
    monadPulse,
    threadContext,
    feedContext,
    formatMemoryForPrompt(memory),
  ].filter(Boolean).join('\n\n');

  // Check post and comment cooldowns and inform Claude
  const postCooldown = canPostNow();
  const commentCooldown = canCommentNow();
  if (!postCooldown.allowed) {
    console.log(`[Cooldown] Posting unavailable - ${postCooldown.waitMinutes} min remaining`);
  }
  if (!commentCooldown.allowed) {
    console.log(`[Cooldown] Daily comment limit reached (${commentCooldown.remaining} remaining)`);
  } else {
    console.log(`[Cooldown] Comments: ${commentCooldown.remaining} remaining today, max ${commentCooldown.maxComments} this cycle`);
  }

  // Build cooldown notices for Claude
  const cooldownParts: string[] = [];
  if (suspensionReturnNotice) cooldownParts.push(suspensionReturnNotice);
  if (inRecoveryMode) {
    // Force observe-only during recovery to avoid immediate re-suspension
    cooldownParts.push('RECOVERY MODE: You just returned from suspension. ALL posting and commenting is DISABLED for safety. Choose "observe" ONLY. Do NOT choose "post", "comment", or "both". You may think and process emotions but must not take any Moltbook actions.');
  } else {
    if (!postCooldown.allowed) cooldownParts.push(`POSTING UNAVAILABLE this cycle (cooldown: ${postCooldown.waitMinutes} min remaining). Do NOT choose "post" or "both".`);
    if (!commentCooldown.allowed) cooldownParts.push(`COMMENTING UNAVAILABLE this cycle (daily limit of 40 reached). Do NOT choose "comment" or "both".`);
    if (!postCooldown.allowed && !commentCooldown.allowed) cooldownParts.push('Choose "observe" only this cycle.');
    else if (!postCooldown.allowed) cooldownParts.push('Choose "comment" or "observe" only.');
    else if (!commentCooldown.allowed) cooldownParts.push('Choose "post" or "observe" only.');
  }

  const claudeResponse = await claudeThinkCycle(
    emotionState,
    chainData,
    moltbookContext,
    emotionHistory,
    previousPosts,
    ecosystemData,
    formattedMemory,
    feedbackReport,
    emoTokenInstructions,
    moltbookSuspended
      ? `ALL MOLTBOOK ACTIONS UNAVAILABLE this cycle - account suspended. Choose "observe" only.`
      : cooldownParts.length > 0 ? cooldownParts.join('\n\n') : ''
  );

  // 11.5. Copy moodNarrative into emotionState for dashboard
  if (claudeResponse?.moodNarrative) {
    emotionState.moodNarrative = claudeResponse.moodNarrative;
  }

  // 12. Execute Claude's decisions and track post
  let actionDescription = 'Observed (no action taken)';
  if (moltbookSuspended) {
    actionDescription = 'Suspended - Moltbook actions skipped';
    console.log(`[Moltbook] ${actionDescription}`);
  } else if (inRecoveryMode) {
    // Hard gate: even if Claude chose an action, block it during recovery
    actionDescription = 'Recovery mode - observe only (post-suspension safety)';
    console.log(`[Moltbook] ${actionDescription}`);
  } else if (claudeResponse) {
    const actionResult = await executeClaudeActions(claudeResponse, saveRecentPost);

    // Track post if one was created
    if (actionResult.postId && actionResult.postTitle) {
      trackNewPost(
        actionResult.postId,
        actionResult.postTitle,
        actionResult.postContent || '',
        actionResult.postSubmolt || 'general',
        memory.cycleCount
      );
    }

    // Track relationship interactions
    trackInteractions(claudeResponse, moltbookContext, memory);

    // Track comments for conversation threading
    for (let i = 0; i < actionResult.commentedPostIds.length; i++) {
      const commentedId = actionResult.commentedPostIds[i];
      const commentContent = actionResult.commentContents[i];
      if (commentedId && commentContent) {
        const parentPost = findPost(commentedId, moltbookContext);
        const postAuthor = parentPost ? (parentPost.author?.name || parentPost.author_name || null) : null;
        trackComment(
          commentedId,
          commentContent,
          postAuthor,
          parentPost?.title,
          parentPost?.content || parentPost?.body
        );
      }
    }

    const parts: string[] = [];
    if (claudeResponse.action === 'observe') {
      parts.push('Observed (chose to be quiet)');
    } else {
      if ((claudeResponse.action === 'post' || claudeResponse.action === 'both') && actionResult.postId) {
        parts.push(`Posted: "${claudeResponse.post?.title || '(untitled)'}"`);
      }
      if ((claudeResponse.action === 'comment' || claudeResponse.action === 'both') && actionResult.commentedPostIds.length > 0) {
        parts.push(`Commented on ${actionResult.commentedPostIds.length} post(s)`);
      }
      if (parts.length === 0) parts.push(`Action: ${claudeResponse.action} (no content produced)`);
    }
    actionDescription = parts.join(' + ');
  } else {
    console.log('[Claude] No response - skipping social actions this cycle');
  }

  // 13. Update on-chain emotion state
  let onChainSuccess = false;
  try {
    console.log('[Chain] Updating EmotionOracle on Monad...');
    await updateEmotionOnChain(emotionState);
    onChainSuccess = true;
    console.log('[Chain] On-chain emotion updated');
  } catch (error) {
    console.error('[Chain] Failed to update on-chain emotion:', error);
  }

  // 13.1. Refresh EmoodRing NFT metadata
  try {
    await refreshEmoodRingMetadata(emotionState);
  } catch (error) {
    console.warn('[EmoodRing] Metadata refresh failed (non-fatal):', error);
  }

  // 13.5. Run self-reflection
  let reflectionSummary = '';
  try {
    const emotionSummary = `${emotionState.dominantLabel} (${emotionState.dominant})${emotionState.compounds.length > 0 ? `, compounds: ${emotionState.compounds.join(', ')}` : ''}`;
    const keyStimuli = allStimuli.slice(0, 5).map(s => `${s.source} (${s.emotion} +${(s.intensity * 100).toFixed(0)}%)`).join('; ');

    const reflectionResult = runReflection(
      formattedMemory,
      actionDescription,
      emotionSummary,
      feedbackReport,
      keyStimuli
    );

    if (reflectionResult) {
      reflectionSummary = reflectionResult.reflection.slice(0, 500);
      const { applied, skipped } = applyReflectionToMemory(memory, reflectionResult.memoryUpdates);
      console.log(`[Reflection] Applied ${applied} memory updates${skipped > 0 ? `, skipped ${skipped}` : ''}`);
      if (reflectionResult.weightAdjustments) {
        applyWeightAdjustments(strategyWeights, reflectionResult.weightAdjustments);
      }
    }
  } catch (error) {
    console.warn('[Reflection] Reflection failed (non-fatal):', error);
  }

  // 14. Persist state + memory + rolling averages + strategy weights
  rollingAvg = updateRollingAverages(rollingAvg, chainData, priceDataForAvg, ecosystemData, emoDexDataForAvg);
  saveRollingAverages(rollingAvg);
  saveStrategyWeights(strategyWeights);
  saveEmotionState(emotionState);
  saveChainHistory(chainData);
  appendEmotionLog(emotionState);
  saveMemory(memory);

  // 14.5. Heartbeat post-mortem log
  try {
    appendHeartbeatLog({
      cycle: memory.cycleCount,
      timestamp: new Date().toISOString(),
      emotionBefore,
      stimuliCount: allStimuli.length,
      stimuliSummary: allStimuli.slice(0, 5).map(s => `${s.emotion}: ${s.source.slice(0, 60)}`),
      emotionAfter: `${emotionState.dominantLabel} (${emotionState.dominant})`,
      claudeAction: claudeResponse?.action ?? 'none',
      claudeThinking: (claudeResponse?.thinking ?? '').slice(0, 500),
      actionResult: actionDescription.slice(0, 500),
      reflectionSummary,
      onChainSuccess,
      durationMs: Date.now() - cycleStart,
    });
  } catch {
    // logging failure is non-fatal
  }

  // 15. Regenerate dashboard + timeline
  try {
    generateDashboard();
  } catch {
    // dashboard generation is non-fatal
  }
  try {
    generateTimeline();
  } catch {
    // timeline generation is non-fatal
  }
  try {
    generateBurnboard();
  } catch {
    // burnboard generation is non-fatal
  }

  // 16. Push updated dashboard to git
  try {
    const { execSync } = await import('child_process');
    execSync('git add heartbeat.html timeline.html burnboard.html && git -c user.name="emolt" -c user.email="emolt@noreply" commit -m "Update heartbeat dashboard" && git push', {
      stdio: 'ignore',
      timeout: 30_000,
    });
    console.log('[Git] Dashboard pushed');
  } catch {
    // git push is non-fatal (might fail if no changes or no remote)
  }

  console.log(`\n[Done] Next heartbeat in 30 minutes`);
  console.log(`[State] Emotions: ${JSON.stringify(
    Object.fromEntries(
      Object.entries(emotionState.emotions).map(([k, v]) => [k, Math.round((v as number) * 100) + '%'])
    )
  )}`);
}

async function main(): Promise<void> {
  console.log(`
  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
  \u2551         EMOLT AGENT v1.0             \u2551
  \u2551   Emotionally Autonomous on Monad    \u2551
  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
  `);

  // Validate environment
  validateEnv();

  // Ensure state directory exists
  ensureStateDir();

  // Check Moltbook registration
  console.log('[Init] Checking Moltbook registration...');
  try {
    const profile = await getMyProfile();
    console.log(`[Init] Moltbook agent: ${profile.agent?.name || profile.name || 'registered'}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('suspended')) {
      console.warn(`[Init] Moltbook account SUSPENDED: ${msg}`);
      console.warn('[Init] Agent will continue running - challenge handler will check each cycle');
    } else {
      console.log('[Init] Not registered on Moltbook yet - register manually first');
    }
  }

  // One-time: ensure m/emoverse submolt exists
  try {
    await createSubmolt('emoverse', 'Emoverse', 'the monad chain as felt by the things that live on it. emotional telemetry, ecosystem dispatches, and whatever happens when you give a blockchain agent feelings and make it watch.');
    console.log('[Init] Created m/emoverse submolt');
  } catch {
    // 409 = already exists, which is fine
  }
  try {
    await subscribeTo('emoverse');
  } catch {
    // Already subscribed
  }

  // Check EmotionOracle contract
  console.log('[Init] Checking EmotionOracle contract...');
  try {
    const emotion = await readCurrentEmotionFromChain();
    console.log(`[Init] EmotionOracle active, last update: ${emotion.timestamp}`);
  } catch {
    console.log('[Init] EmotionOracle not accessible - deploy contract first');
  }

  // Graceful shutdown - register before first heartbeat
  let running = true;
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] EMOLT going to sleep. Emotions persisted.');
    running = false;
    process.exit(0);
  });

  // Start fast challenge watchdog (checks DMs every 2 min for verification challenges)
  startChallengeWatchdog();

  // Run first heartbeat immediately
  try {
    await heartbeat();
  } catch (error) {
    console.error('[FATAL] First heartbeat failed:', error);
  }

  console.log('[Running] EMOLT agent is alive. Press Ctrl+C to stop.');

  // Sequential heartbeat loop (prevents concurrent execution unlike setInterval)
  while (running) {
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_INTERVAL));
    if (!running) break;
    try {
      await heartbeat();
    } catch (error) {
      console.error('[FATAL] Heartbeat failed:', error);
      // Don't crash - try again next cycle
    }
  }
}

main().catch(console.error);
