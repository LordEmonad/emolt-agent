import { readFileSync } from 'fs';
import type { DexScreenerMarketData, DexScreenerPairData } from './types.js';

// Circuit breaker: 3 failures → 90-min cooldown
let failures = 0;
let skipUntil = 0;

// Previous-cycle cache for delta computation — seed from last saved snapshot
let previousPairs: Set<string> = new Set();
let previousVolume = 0;
let previousLiquidity = 0;
try {
  const prev = JSON.parse(readFileSync('./state/dex-screener-data.json', 'utf-8'));
  if (prev?.dataAvailable) {
    previousVolume = prev.totalVolume1h || 0;
    previousLiquidity = prev.totalLiquidity || 0;
    if (prev.topPairs) {
      for (const p of prev.topPairs) if (p.pairAddress) previousPairs.add(p.pairAddress);
    }
  }
} catch { /* no previous data on first run */ }

function isCircuitOpen(): boolean {
  if (failures >= 3 && Date.now() < skipUntil) {
    console.warn('[DexScreener] Circuit open, skipping');
    return true;
  }
  if (Date.now() >= skipUntil) failures = 0;
  return false;
}

function recordSuccess(): void { failures = 0; skipUntil = 0; }
function recordFailure(): void {
  failures++;
  if (failures >= 3) {
    skipUntil = Date.now() + 90 * 60 * 1000;
    console.warn('[DexScreener] Circuit breaker tripped, cooling down for 90min');
  }
}

const EMPTY: DexScreenerMarketData = {
  totalVolume1h: 0, totalLiquidity: 0, buyTxCount: 0, sellTxCount: 0,
  buySellRatio: 1, topPairs: [], newPairsCount: 0, volumeChangePct: 0,
  liquidityChangePct: 0, fetchedAt: Date.now(), dataAvailable: false,
};

export async function collectDexScreenerData(): Promise<DexScreenerMarketData> {
  if (isCircuitOpen()) return { ...EMPTY, fetchedAt: Date.now() };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    // Try token search for Monad chain pairs
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=MON%20USDC',
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      // Fallback: broader search that still captures Monad pairs
      const fallbackRes = await fetch(
        'https://api.dexscreener.com/latest/dex/search?q=monad',
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!fallbackRes.ok) throw new Error(`DexScreener ${fallbackRes.status}`);
      return processPairs(await fallbackRes.json());
    }

    return processPairs(await res.json());
  } catch (error) {
    recordFailure();
    console.warn('[DexScreener] Fetch failed:', error);
    return { ...EMPTY, fetchedAt: Date.now() };
  }
}

function processPairs(data: any): DexScreenerMarketData {
  // Filter to Monad chain only — DexScreener search returns cross-chain results
  const pairs: any[] = (data?.pairs || []).filter((p: any) => p.chainId === 'monad');
  if (pairs.length === 0) {
    recordSuccess();
    return { ...EMPTY, fetchedAt: Date.now() };
  }

  let totalVolume1h = 0;
  let totalLiquidity = 0;
  let buyTxCount = 0;
  let sellTxCount = 0;
  const currentPairs = new Set<string>();
  const pairData: DexScreenerPairData[] = [];

  for (const p of pairs) {
    const addr = p.pairAddress || '';
    currentPairs.add(addr);

    const vol1h = p.volume?.h1 ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    const buys = p.txns?.h1?.buys ?? 0;
    const sells = p.txns?.h1?.sells ?? 0;

    totalVolume1h += vol1h;
    totalLiquidity += liq;
    buyTxCount += buys;
    sellTxCount += sells;

    pairData.push({
      pairAddress: addr,
      dexId: p.dexId || 'unknown',
      baseToken: { symbol: p.baseToken?.symbol || '?', name: p.baseToken?.name || '?' },
      quoteToken: { symbol: p.quoteToken?.symbol || '?', name: p.quoteToken?.name || '?' },
      priceUsd: parseFloat(p.priceUsd || '0'),
      volume1h: vol1h,
      buys1h: buys,
      sells1h: sells,
      liquidityUsd: liq,
      priceChange1h: p.priceChange?.h1 ?? 0,
    });
  }

  // Top 3 by volume
  pairData.sort((a, b) => b.volume1h - a.volume1h);
  const topPairs = pairData.slice(0, 3);

  // New pairs since last cycle
  let newPairsCount = 0;
  if (previousPairs.size > 0) {
    for (const addr of currentPairs) {
      if (!previousPairs.has(addr)) newPairsCount++;
    }
  }

  // Deltas
  const volumeChangePct = previousVolume > 0
    ? ((totalVolume1h - previousVolume) / previousVolume) * 100
    : 0;
  const liquidityChangePct = previousLiquidity > 0
    ? ((totalLiquidity - previousLiquidity) / previousLiquidity) * 100
    : 0;

  // Update cache
  previousPairs = currentPairs;
  previousVolume = totalVolume1h;
  previousLiquidity = totalLiquidity;

  const totalTx = buyTxCount + sellTxCount;
  const buySellRatio = sellTxCount > 0 ? buyTxCount / sellTxCount : (buyTxCount > 0 ? 2.0 : 1.0);

  recordSuccess();
  return {
    totalVolume1h,
    totalLiquidity,
    buyTxCount,
    sellTxCount,
    buySellRatio,
    topPairs,
    newPairsCount,
    volumeChangePct,
    liquidityChangePct,
    fetchedAt: Date.now(),
    dataAvailable: true,
  };
}

export function formatDexScreenerForPrompt(data: DexScreenerMarketData): string {
  if (!data.dataAvailable) return '';

  const lines: string[] = ['MON Trading Pulse (DexScreener — MON pairs on Monad DEXs):'];

  lines.push(`  MON 1h volume across all Monad DEXs: $${(data.totalVolume1h / 1e3).toFixed(1)}K`);
  if (data.volumeChangePct !== 0) {
    lines.push(`  MON volume change vs last cycle: ${data.volumeChangePct > 0 ? '+' : ''}${data.volumeChangePct.toFixed(1)}%`);
  }
  lines.push(`  MON total liquidity: $${(data.totalLiquidity / 1e6).toFixed(2)}M`);
  if (data.liquidityChangePct !== 0) {
    lines.push(`  MON liquidity change vs last cycle: ${data.liquidityChangePct > 0 ? '+' : ''}${data.liquidityChangePct.toFixed(1)}%`);
  }
  lines.push(`  MON buy/sell ratio (1h): ${data.buySellRatio.toFixed(2)} (${data.buyTxCount} MON buys / ${data.sellTxCount} MON sells)`);

  if (data.topPairs.length > 0) {
    lines.push('  Top pairs by volume:');
    for (const p of data.topPairs) {
      lines.push(`    - ${p.baseToken.symbol}/${p.quoteToken.symbol} on ${p.dexId}: $${p.priceUsd.toFixed(4)} | vol $${(p.volume1h / 1e3).toFixed(1)}K | liq $${(p.liquidityUsd / 1e3).toFixed(0)}K`);
    }
  }

  if (data.newPairsCount > 0) {
    lines.push(`  New pairs detected: ${data.newPairsCount}`);
  }

  return lines.join('\n');
}
