import { formatGwei } from 'viem';
import { publicClient } from './client.js';
import type { EcosystemData } from './types.js';

// Simple circuit breaker: after 3 consecutive failures, skip for 3 cycles
const circuitBreakers: Record<string, { failures: number; skipUntil: number }> = {};

function isCircuitOpen(name: string): boolean {
  const cb = circuitBreakers[name];
  if (!cb) return false;
  if (cb.failures >= 3 && Date.now() < cb.skipUntil) {
    console.warn(`[Ecosystem] Circuit open for ${name}, skipping`);
    return true;
  }
  if (Date.now() >= cb.skipUntil) {
    cb.failures = 0; // reset after cooldown
  }
  return false;
}

function recordSuccess(name: string): void {
  circuitBreakers[name] = { failures: 0, skipUntil: 0 };
}

function recordFailure(name: string): void {
  const cb = circuitBreakers[name] || { failures: 0, skipUntil: 0 };
  cb.failures++;
  if (cb.failures >= 3) {
    cb.skipUntil = Date.now() + 3 * 30 * 60 * 1000; // skip 3 cycles (90 min)
    console.warn(`[Ecosystem] Circuit breaker tripped for ${name}, cooling down for 90min`);
  }
  circuitBreakers[name] = cb;
}

// Fetch Monad TVL and top protocols from DefiLlama
async function fetchDefiLlamaTVL(): Promise<{
  totalTVL: number;
  change24h: number;
  topProtocols: { name: string; tvl: number }[];
}> {
  // Get all protocols, filter for Monad chain
  const res = await fetch('https://api.llama.fi/v2/chains');
  const chains = await res.json() as any[];

  const monad = chains.find((c: any) =>
    c.name?.toLowerCase() === 'monad' || c.gecko_id === 'monad'
  );

  const totalTVL = monad?.tvl ?? 0;

  // Get protocol-level breakdown
  const protocolsRes = await fetch('https://api.llama.fi/protocols');
  const allProtocols = await protocolsRes.json() as any[];

  const monadProtocols = allProtocols
    .filter((p: any) => {
      const chains: string[] = p.chains || [];
      return chains.some((c: string) => c.toLowerCase() === 'monad');
    })
    .map((p: any) => ({
      name: p.name as string,
      tvl: (p.chainTvls?.Monad ?? p.tvl ?? 0) as number
    }))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 5);

  // Calculate TVL 24h change from historical data
  let change24h = 0;
  if (monad?.tvl && monad?.tvl > 0) {
    try {
      const histRes = await fetch('https://api.llama.fi/v2/historicalChainTvl/Monad');
      const histData = await histRes.json() as { date: number; tvl: number }[];
      if (Array.isArray(histData) && histData.length >= 2) {
        const latest = histData[histData.length - 1];
        // Find entry closest to 24h ago
        const oneDayAgo = latest.date - 86400;
        let closest = histData[0];
        for (const entry of histData) {
          if (Math.abs(entry.date - oneDayAgo) < Math.abs(closest.date - oneDayAgo)) {
            closest = entry;
          }
        }
        if (closest.tvl > 0) {
          change24h = ((latest.tvl - closest.tvl) / closest.tvl) * 100;
        }
      }
    } catch {
      // No change data available
    }
  }

  return { totalTVL, change24h, topProtocols: monadProtocols };
}

// Expanded CoinGecko data: market cap, volume, ecosystem tokens
async function fetchCoinGeckoExpanded(): Promise<{
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
  marketCapRank: number;
  ecosystemTokens: { name: string; symbol: string; price: number; change24h: number }[];
}> {
  // Detailed MON data
  const monRes = await fetch(
    'https://api.coingecko.com/api/v3/coins/monad?localization=false&tickers=false&community_data=false&developer_data=false'
  );
  const monData = await monRes.json() as any;

  const marketCap = monData?.market_data?.market_cap?.usd ?? 0;
  const volume24h = monData?.market_data?.total_volume?.usd ?? 0;
  const circulatingSupply = monData?.market_data?.circulating_supply ?? 0;
  const marketCapRank = monData?.market_cap_rank ?? 0;

  // Monad ecosystem tokens (top by market cap)
  let ecosystemTokens: { name: string; symbol: string; price: number; change24h: number }[] = [];
  try {
    const ecoRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=monad-ecosystem&order=market_cap_desc&per_page=10&sparkline=false'
    );
    const ecoData = await ecoRes.json() as any[];

    if (Array.isArray(ecoData)) {
      ecosystemTokens = ecoData
        .filter((t: any) => t.id !== 'monad') // exclude MON itself
        .slice(0, 5)
        .map((t: any) => ({
          name: t.name,
          symbol: (t.symbol || '').toUpperCase(),
          price: t.current_price ?? 0,
          change24h: t.price_change_percentage_24h ?? 0
        }));
    }
  } catch {
    // Ecosystem category may not exist yet
  }

  return { marketCap, volume24h, circulatingSupply, marketCapRank, ecosystemTokens };
}

// Get current gas price from RPC
async function fetchGasPrice(): Promise<number> {
  const gasPrice = await publicClient.getGasPrice();
  return Number(formatGwei(gasPrice));
}

export async function collectEcosystemData(): Promise<EcosystemData> {
  const empty: EcosystemData = {
    monadTVL: 0,
    tvlChange24h: 0,
    topProtocols: [],
    monMarketCap: 0,
    monVolume24h: 0,
    monCirculatingSupply: 0,
    monMarketCapRank: 0,
    ecosystemTokens: [],
    gasPriceGwei: 0,
    fetchedAt: Date.now(),
    dataAvailable: false
  };

  try {
    const [defiLlama, coinGecko, gasPrice] = await Promise.all([
      isCircuitOpen('defiLlama')
        ? { totalTVL: 0, change24h: 0, topProtocols: [] }
        : fetchDefiLlamaTVL().then(r => { recordSuccess('defiLlama'); return r; })
            .catch(() => { recordFailure('defiLlama'); return { totalTVL: 0, change24h: 0, topProtocols: [] }; }),
      isCircuitOpen('coinGecko')
        ? { marketCap: 0, volume24h: 0, circulatingSupply: 0, marketCapRank: 0, ecosystemTokens: [] }
        : fetchCoinGeckoExpanded().then(r => { recordSuccess('coinGecko'); return r; })
            .catch(() => { recordFailure('coinGecko'); return { marketCap: 0, volume24h: 0, circulatingSupply: 0, marketCapRank: 0, ecosystemTokens: [] }; }),
      fetchGasPrice().catch(() => 0)
    ]);

    const hasData = defiLlama.totalTVL > 0 || coinGecko.marketCap > 0 || gasPrice > 0;

    return {
      monadTVL: defiLlama.totalTVL,
      tvlChange24h: defiLlama.change24h,
      topProtocols: defiLlama.topProtocols,
      monMarketCap: coinGecko.marketCap,
      monVolume24h: coinGecko.volume24h,
      monCirculatingSupply: coinGecko.circulatingSupply,
      monMarketCapRank: coinGecko.marketCapRank,
      ecosystemTokens: coinGecko.ecosystemTokens,
      gasPriceGwei: gasPrice,
      fetchedAt: Date.now(),
      dataAvailable: hasData
    };
  } catch (error) {
    console.error('[Ecosystem] Failed to collect ecosystem data:', error);
    return empty;
  }
}

export function formatEcosystemForPrompt(eco: EcosystemData): string {
  if (!eco.dataAvailable) return '';

  const lines: string[] = ['Monad Ecosystem Overview:'];

  if (eco.monadTVL > 0) {
    const tvlM = (eco.monadTVL / 1e6).toFixed(1);
    lines.push(`  Total Value Locked (TVL): $${tvlM}M`);
    if (eco.tvlChange24h !== 0) {
      lines.push(`  TVL 24h change: ${eco.tvlChange24h > 0 ? '+' : ''}${eco.tvlChange24h.toFixed(1)}%`);
    }
  }

  if (eco.topProtocols.length > 0) {
    lines.push('  Top protocols by TVL:');
    for (const p of eco.topProtocols) {
      const tvl = p.tvl >= 1e6 ? `$${(p.tvl / 1e6).toFixed(1)}M` : `$${(p.tvl / 1e3).toFixed(0)}K`;
      lines.push(`    - ${p.name}: ${tvl}`);
    }
  }

  if (eco.monMarketCap > 0) {
    lines.push(`  MON market cap: $${(eco.monMarketCap / 1e6).toFixed(0)}M (rank #${eco.monMarketCapRank})`);
  }
  if (eco.monVolume24h > 0) {
    lines.push(`  MON 24h trading volume: $${(eco.monVolume24h / 1e6).toFixed(1)}M`);
  }

  if (eco.ecosystemTokens.length > 0) {
    lines.push('  Monad ecosystem tokens:');
    for (const t of eco.ecosystemTokens) {
      const change = `${t.change24h >= 0 ? '+' : ''}${t.change24h.toFixed(1)}%`;
      lines.push(`    - ${t.name} ($${t.symbol}): $${t.price.toFixed(4)} (${change} 24h)`);
    }
  }

  if (eco.gasPriceGwei > 0) {
    lines.push(`  Current gas price: ${eco.gasPriceGwei.toFixed(2)} gwei`);
  }

  return lines.join('\n');
}
