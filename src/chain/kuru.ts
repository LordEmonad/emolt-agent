import type { KuruOrderbookData } from './types.js';

// MON/USDC market on Kuru
const KURU_MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394';
const KURU_L2_URL = `https://api.kuru.io/api/v2/orders/market/${KURU_MARKET}/l2book`;

// Circuit breaker: 3 failures → 90-min cooldown
let failures = 0;
let skipUntil = 0;

// Previous-cycle cache for delta computation
let previousSpreadPct = 0;
let previousTotalDepth = 0;

function isCircuitOpen(): boolean {
  if (failures >= 3 && Date.now() < skipUntil) {
    console.warn('[Kuru] Circuit open, skipping');
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
    console.warn('[Kuru] Circuit breaker tripped, cooling down for 90min');
  }
}

const EMPTY: KuruOrderbookData = {
  bestBid: 0, bestAsk: 0, spreadPct: 0, midPrice: 0,
  bidDepthMon: 0, askDepthMon: 0, bidDepthUsd: 0, askDepthUsd: 0,
  bookImbalance: 0.5, whaleOrders: 0, spreadChangePct: 0,
  depthChangeRatio: 1, fetchedAt: Date.now(), dataAvailable: false,
};

export async function collectKuruOrderbook(): Promise<KuruOrderbookData> {
  if (isCircuitOpen()) return { ...EMPTY, fetchedAt: Date.now() };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(KURU_L2_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Kuru ${res.status}`);

    const data = await res.json() as any;
    return processOrderbook(data);
  } catch (error) {
    recordFailure();
    console.warn('[Kuru] Fetch failed:', error);
    return { ...EMPTY, fetchedAt: Date.now() };
  }
}

function processOrderbook(raw: any): KuruOrderbookData {
  // Kuru API wraps data in { success, code, data: { bids, asks, syncBlock } }
  // Prices are raw integers with pricePrecision = 1e8 (divide by 1e8 for USD)
  // Sizes are raw integers with sizePrecision = 1e10 (divide by 1e10 for MON)
  const PRICE_PRECISION = 1e8;
  const SIZE_PRECISION = 1e10;

  const bookData = raw?.data || raw; // handle both wrapped and unwrapped formats
  const rawBids: any[] = bookData?.bids || [];
  const rawAsks: any[] = bookData?.asks || [];

  // Decode to real values: [priceUsd, sizeMon]
  const bids: [number, number][] = rawBids.map((b: any) => [
    parseFloat(b[0] || '0') / PRICE_PRECISION,
    parseFloat(b[1] || '0') / SIZE_PRECISION,
  ]);
  const asks: [number, number][] = rawAsks.map((a: any) => [
    parseFloat(a[0] || '0') / PRICE_PRECISION,
    parseFloat(a[1] || '0') / SIZE_PRECISION,
  ]);

  if (bids.length === 0 && asks.length === 0) {
    recordSuccess();
    return { ...EMPTY, fetchedAt: Date.now() };
  }

  // Best bid/ask (bids sorted desc, asks sorted asc by Kuru)
  const bestBid = bids.length > 0 ? Math.max(...bids.map(b => b[0])) : 0;
  const bestAsk = asks.length > 0 ? Math.min(...asks.filter(a => a[0] > 0).map(a => a[0])) : 0;
  const midPrice = (bestBid > 0 && bestAsk > 0) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
  const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

  // Depth calculations (size in MON after decoding)
  let bidDepthMon = 0;
  let askDepthMon = 0;
  let whaleOrders = 0;

  for (const [, size] of bids) {
    bidDepthMon += size;
    if (size > 10000) whaleOrders++;
  }
  for (const [, size] of asks) {
    askDepthMon += size;
    if (size > 10000) whaleOrders++;
  }

  const bidDepthUsd = bidDepthMon * midPrice;
  const askDepthUsd = askDepthMon * midPrice;
  const totalDepth = bidDepthMon + askDepthMon;
  const bookImbalance = totalDepth > 0 ? bidDepthMon / totalDepth : 0.5;

  // Deltas vs previous cycle
  const spreadChangePct = previousSpreadPct > 0
    ? ((spreadPct - previousSpreadPct) / previousSpreadPct) * 100
    : 0;
  const depthChangeRatio = previousTotalDepth > 0
    ? totalDepth / previousTotalDepth
    : 1;

  // Update cache
  previousSpreadPct = spreadPct;
  previousTotalDepth = totalDepth;

  recordSuccess();
  return {
    bestBid,
    bestAsk,
    spreadPct,
    midPrice,
    bidDepthMon,
    askDepthMon,
    bidDepthUsd,
    askDepthUsd,
    bookImbalance,
    whaleOrders,
    spreadChangePct,
    depthChangeRatio,
    fetchedAt: Date.now(),
    dataAvailable: true,
  };
}

export function formatKuruOrderbookForPrompt(data: KuruOrderbookData): string {
  if (!data.dataAvailable) return '';

  const lines: string[] = ['MON/USDC Orderbook (Kuru):'];

  lines.push(`  Best bid: $${data.bestBid.toFixed(4)} | Best ask: $${data.bestAsk.toFixed(4)}`);
  lines.push(`  Spread: ${data.spreadPct.toFixed(3)}% | Midpoint: $${data.midPrice.toFixed(4)}`);
  if (data.spreadChangePct !== 0) {
    lines.push(`  Spread change vs last cycle: ${data.spreadChangePct > 0 ? '+' : ''}${data.spreadChangePct.toFixed(1)}%`);
  }

  lines.push(`  Bid depth: ${data.bidDepthMon.toFixed(0)} MON ($${(data.bidDepthUsd / 1e3).toFixed(1)}K)`);
  lines.push(`  Ask depth: ${data.askDepthMon.toFixed(0)} MON ($${(data.askDepthUsd / 1e3).toFixed(1)}K)`);

  const imbalanceLabel = data.bookImbalance > 0.6 ? 'bid-heavy (buyers)' :
                         data.bookImbalance < 0.4 ? 'ask-heavy (sellers)' : 'balanced';
  lines.push(`  Book imbalance: ${(data.bookImbalance * 100).toFixed(1)}% bid-side (${imbalanceLabel})`);

  if (data.depthChangeRatio !== 1) {
    const depthChange = ((data.depthChangeRatio - 1) * 100).toFixed(1);
    lines.push(`  Depth change vs last cycle: ${data.depthChangeRatio > 1 ? '+' : ''}${depthChange}%`);
  }

  if (data.whaleOrders > 0) {
    lines.push(`  Whale orders (>10K MON): ${data.whaleOrders}`);
  }

  return lines.join('\n');
}
