// Etherscan V2 API - Monad chain metrics (chainid 143)

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 143;
const API_KEY = process.env.ETHERSCAN_API_KEY || '';

const EMO_TOKEN = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777';
const EMO_POOL = '0x714A2694C8d4f0B1bfbA0E5b76240E439df2182D';

// Rate limit: 5 calls/sec on free tier
let lastCall = 0;
async function etherscanThrottle(): Promise<void> {
  const gap = Date.now() - lastCall;
  if (gap < 220) await new Promise(r => setTimeout(r, 220 - gap));
  lastCall = Date.now();
}

async function esQuery(params: string): Promise<any> {
  await etherscanThrottle();
  const url = `${ETHERSCAN_BASE}?chainid=${CHAIN_ID}&apikey=${API_KEY}&${params}`;
  const res = await fetch(url);
  return res.json();
}

// --- Chain Metrics ---

export interface MonadChainMetrics {
  blockNumber: number;
  blockTime: number;          // seconds per block
  tps: number;                // transactions per second
  avgTxPerBlock: number;
  minTxPerBlock: number;
  maxTxPerBlock: number;
  estTxns30min: number;       // estimated total txns in 30 min
  gasUtilization: number;     // 0-1
  gasPrice: number;           // gwei

  // MON price from Etherscan
  monPriceUsd: number;
  monPriceBtc: number;
}

export async function collectMonadMetrics(): Promise<MonadChainMetrics | null> {
  if (!API_KEY) {
    console.warn('[Etherscan] No API key set (ETHERSCAN_API_KEY)');
    return null;
  }

  try {
    // Get current block number
    const blockRes = await esQuery('module=proxy&action=eth_blockNumber');
    const currentBlock = parseInt(blockRes.result, 16);

    // Sample 20 blocks spread across last ~1800 blocks for tx counts
    const txCounts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const bn = currentBlock - (i * 90);
      const hex = '0x' + bn.toString(16);
      const j = await esQuery(`module=proxy&action=eth_getBlockTransactionCountByNumber&tag=${hex}`);
      txCounts.push(parseInt(j.result, 16) || 0);
    }

    // Get timestamps from 2 blocks to calculate block time
    const [latestRes, olderRes] = await Promise.all([
      esQuery(`module=proxy&action=eth_getBlockByNumber&tag=0x${currentBlock.toString(16)}&boolean=false`),
      esQuery(`module=proxy&action=eth_getBlockByNumber&tag=0x${(currentBlock - 1800).toString(16)}&boolean=false`),
    ]);

    const t1 = parseInt(latestRes.result?.timestamp, 16);
    const t2 = parseInt(olderRes.result?.timestamp, 16);
    const blockTime = (t1 - t2) / 1800;

    const gasUsed = parseInt(latestRes.result?.gasUsed, 16) || 0;
    const gasLimit = parseInt(latestRes.result?.gasLimit, 16) || 1;

    // Gas price
    const gasPriceRes = await esQuery('module=proxy&action=eth_gasPrice');
    const gasPriceWei = parseInt(gasPriceRes.result, 16) || 0;
    const gasPrice = gasPriceWei / 1e9;

    // MON price
    const priceRes = await esQuery('module=stats&action=ethprice');
    const monPriceUsd = parseFloat(priceRes.result?.ethusd) || 0;
    const monPriceBtc = parseFloat(priceRes.result?.ethbtc) || 0;

    const avgTx = txCounts.reduce((s, c) => s + c, 0) / txCounts.length;
    const tps = blockTime > 0 ? avgTx / blockTime : 0;
    const estTxns30min = blockTime > 0 ? avgTx * (1800 / blockTime) : 0;

    return {
      blockNumber: currentBlock,
      blockTime,
      tps,
      avgTxPerBlock: avgTx,
      minTxPerBlock: Math.min(...txCounts),
      maxTxPerBlock: Math.max(...txCounts),
      estTxns30min,
      gasUtilization: gasUsed / gasLimit,
      gasPrice,
      monPriceUsd,
      monPriceBtc,
    };
  } catch (error) {
    console.warn('[Etherscan] Failed to collect chain metrics:', error);
    return null;
  }
}

// --- $EMO Token Transfers ---

export interface EmoTransfer {
  type: 'buy' | 'sell' | 'transfer';
  amount: number;         // EMO tokens
  from: string;
  to: string;
  timestamp: number;
  txHash: string;
}

export interface EmoTransferSummary {
  transfers: EmoTransfer[];
  buyCount: number;
  sellCount: number;
  buyVolume: number;      // total EMO bought
  sellVolume: number;     // total EMO sold
  netFlow: number;        // positive = net buying
  uniqueTraders: number;
  largestTrade: number;
}

export async function collectEmoTransfers(): Promise<EmoTransferSummary | null> {
  if (!API_KEY) return null;

  try {
    const j = await esQuery(
      `module=account&action=tokentx&contractaddress=${EMO_TOKEN}&page=1&offset=50&sort=desc`
    );

    const transfers: EmoTransfer[] = [];
    const traders = new Set<string>();
    let buyCount = 0, sellCount = 0, buyVol = 0, sellVol = 0, largest = 0;
    const poolLower = EMO_POOL.toLowerCase();

    if (!Array.isArray(j.result)) return null;

    for (const tx of j.result) {
      if (!tx.from || !tx.to) continue;
      const amount = parseInt(tx.value) / 1e18;
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();
      const ts = parseInt(tx.timeStamp);

      let type: 'buy' | 'sell' | 'transfer' = 'transfer';
      if (from === poolLower) {
        type = 'buy';
        buyCount++;
        buyVol += amount;
        traders.add(to);
      } else if (to === poolLower) {
        type = 'sell';
        sellCount++;
        sellVol += amount;
        traders.add(from);
      }

      if (amount > largest) largest = amount;

      transfers.push({ type, amount, from: tx.from, to: tx.to, timestamp: ts, txHash: tx.hash });
    }

    return {
      transfers,
      buyCount,
      sellCount,
      buyVolume: buyVol,
      sellVolume: sellVol,
      netFlow: buyVol - sellVol,
      uniqueTraders: traders.size,
      largestTrade: largest,
    };
  } catch (error) {
    console.warn('[Etherscan] Failed to collect $EMO transfers:', error);
    return null;
  }
}

// --- GeckoTerminal Trending Pools ---

export interface TrendingPool {
  name: string;
  volume24h: number;
  buys24h: number;
  sells24h: number;
  priceUsd: string;
  priceChangeH1: number;
  priceChangeH24: number;
}

export interface MonadDexOverview {
  trendingPools: TrendingPool[];
  totalVolume24h: number;
  totalTxns24h: number;
  topPoolName: string;
}

export async function collectMonadDexOverview(): Promise<MonadDexOverview | null> {
  try {
    const res = await fetch('https://api.geckoterminal.com/api/v2/networks/monad/trending_pools');
    if (!res.ok) return null;
    const json = await res.json();
    const pools = json.data || [];

    const trendingPools: TrendingPool[] = [];
    let totalVol = 0, totalTxns = 0;

    for (const p of pools.slice(0, 10)) {
      const a = p.attributes;
      const vol = parseFloat(a.volume_usd?.h24) || 0;
      const buys = a.transactions?.h24?.buys || 0;
      const sells = a.transactions?.h24?.sells || 0;

      totalVol += vol;
      totalTxns += buys + sells;

      trendingPools.push({
        name: a.name || 'Unknown',
        volume24h: vol,
        buys24h: buys,
        sells24h: sells,
        priceUsd: a.base_token_price_usd || '0',
        priceChangeH1: parseFloat(a.price_change_percentage?.h1) || 0,
        priceChangeH24: parseFloat(a.price_change_percentage?.h24) || 0,
      });
    }

    return {
      trendingPools,
      totalVolume24h: totalVol,
      totalTxns24h: totalTxns,
      topPoolName: trendingPools[0]?.name || 'none',
    };
  } catch (error) {
    console.warn('[GeckoTerminal] Failed to collect Monad DEX overview:', error);
    return null;
  }
}

// --- Format for Claude Prompt ---

export function formatMonadMetricsForPrompt(
  metrics: MonadChainMetrics | null,
  dex: MonadDexOverview | null,
  emoTransfers: EmoTransferSummary | null
): string {
  const lines: string[] = ['## Monad Chain Pulse\n'];

  if (metrics) {
    lines.push('**Network:**');
    lines.push(`- Block: ${metrics.blockNumber.toLocaleString()} | Block time: ${metrics.blockTime.toFixed(2)}s`);
    lines.push(`- TPS: ${metrics.tps.toFixed(1)} | ~${Math.round(metrics.estTxns30min).toLocaleString()} txns/30min`);
    lines.push(`- Txns/block: avg ${metrics.avgTxPerBlock.toFixed(1)} (range ${metrics.minTxPerBlock}-${metrics.maxTxPerBlock})`);
    lines.push(`- Gas: ${metrics.gasPrice.toFixed(1)} gwei | Utilization: ${(metrics.gasUtilization * 100).toFixed(1)}%`);
    lines.push(`- MON: $${metrics.monPriceUsd.toFixed(4)} | ${metrics.monPriceBtc.toFixed(12)} BTC`);
    lines.push('');
  }

  if (dex && dex.trendingPools.length > 0) {
    lines.push('**DEX Activity (24h):**');
    lines.push(`- Total volume: $${(dex.totalVolume24h / 1e6).toFixed(2)}M across ${dex.totalTxns24h.toLocaleString()} trades`);
    lines.push('- Top pairs:');
    for (const pool of dex.trendingPools.slice(0, 5)) {
      const change = pool.priceChangeH1 >= 0 ? `+${pool.priceChangeH1.toFixed(1)}%` : `${pool.priceChangeH1.toFixed(1)}%`;
      lines.push(`  - ${pool.name}: $${(pool.volume24h / 1e3).toFixed(0)}K vol, ${(pool.buys24h + pool.sells24h).toLocaleString()} trades (${change} 1h)`);
    }
    lines.push('');
  }

  if (emoTransfers) {
    const recent = emoTransfers.transfers.filter(t => t.type !== 'transfer');
    lines.push('**$EMO Token Activity (recent):**');
    if (recent.length === 0) {
      lines.push('- No buys or sells recently');
    } else {
      lines.push(`- ${emoTransfers.buyCount} buys (${emoTransfers.buyVolume.toFixed(0)} EMO) | ${emoTransfers.sellCount} sells (${emoTransfers.sellVolume.toFixed(0)} EMO)`);
      lines.push(`- Net flow: ${emoTransfers.netFlow >= 0 ? '+' : ''}${emoTransfers.netFlow.toFixed(0)} EMO (${emoTransfers.netFlow >= 0 ? 'buying pressure' : 'selling pressure'})`);
      lines.push(`- ${emoTransfers.uniqueTraders} unique traders | Largest trade: ${emoTransfers.largestTrade.toFixed(0)} EMO`);

      // Show last 5 buys/sells
      const recentTrades = recent.slice(0, 5);
      if (recentTrades.length > 0) {
        lines.push('- Recent:');
        for (const t of recentTrades) {
          const ago = Math.round((Date.now() / 1000 - t.timestamp) / 60);
          const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
          lines.push(`  - ${t.type.toUpperCase()} ${t.amount.toFixed(0)} EMO (${agoStr})`);
        }
      }
    }
  }

  return lines.join('\n');
}
