/**
 * Standalone script to fetch real trending data for the dashboard ticker.
 * Run: npx tsx src/dashboard/fetch-trending.ts
 * Then: npx tsx src/dashboard/generate.ts
 */
import { writeFileSync } from 'fs';
import type { DexTickerItem, NadFunTickerItem, EmoTickerData, TrendingData } from '../state/persistence.js';

const STATE_FILE = './state/trending-data.json';

async function fetchMajors(): Promise<DexTickerItem[]> {
  console.log('[CoinGecko] Fetching majors...');
  const ids = 'monad,bitcoin,ethereum,solana';
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();

  const mapping: { id: string; name: string }[] = [
    { id: 'monad', name: 'MON' },
    { id: 'bitcoin', name: 'BTC' },
    { id: 'ethereum', name: 'ETH' },
    { id: 'solana', name: 'SOL' },
  ];

  const items: DexTickerItem[] = [];
  for (const { id, name } of mapping) {
    const coin = data[id];
    if (!coin) continue;
    items.push({
      name,
      priceUsd: coin.usd ?? 0,
      marketCapUsd: coin.usd_market_cap ?? 0,
      changeH24: coin.usd_24h_change ?? 0,
    });
  }

  console.log(`[CoinGecko] ${items.length} majors:`);
  for (const item of items) {
    console.log(`  ${item.name}: $${item.priceUsd} | MC $${(item.marketCapUsd / 1e9).toFixed(1)}B | ${item.changeH24 >= 0 ? '+' : ''}${item.changeH24.toFixed(1)}%`);
  }
  return items;
}

async function fetchNadFun(): Promise<NadFunTickerItem[]> {
  console.log('[nad.fun] Fetching trending tokens...');
  const res = await fetch('https://api.nad.fun/order/market_cap?limit=20');
  if (!res.ok) throw new Error(`nad.fun HTTP ${res.status}`);
  const data = await res.json();
  const allTokens = Array.isArray(data) ? data : (data.tokens ?? data.data ?? []);

  const tokens: NadFunTickerItem[] = [];

  for (const t of allTokens) {
    if (tokens.length >= 10) break;

    const priceUsd = parseFloat(t.market_info?.price_usd || '0');
    const totalSupplyWei = t.market_info?.total_supply || '1000000000000000000000000000';
    const totalSupply = Number(BigInt(totalSupplyWei)) / 1e18;
    const marketCapUsd = priceUsd * totalSupply;

    tokens.push({
      name: t.token_info.name || 'Unknown',
      symbol: t.token_info.symbol || '???',
      priceUsd,
      marketCapUsd,
      priceChangePct: t.percent ?? 0,
    });
  }

  console.log(`[nad.fun] ${tokens.length} tokens:`);
  for (const t of tokens) {
    console.log(`  $${t.symbol}: $${t.priceUsd} | MC $${(t.marketCapUsd / 1e3).toFixed(1)}K | ${t.priceChangePct >= 0 ? '+' : ''}${t.priceChangePct.toFixed(1)}%`);
  }
  return tokens;
}

async function fetchEmoDex(): Promise<EmoTickerData | null> {
  console.log('[DexScreener] Fetching $EMO...');
  const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x81A224F8A62f52BdE942dBF23A56df77A10b7777');
  if (!res.ok) return null;
  const json = await res.json();
  const pair = json.pairs?.[0];
  if (!pair) return null;

  const emo: EmoTickerData = {
    priceUsd: parseFloat(pair.priceUsd) || 0,
    marketCapUsd: pair.marketCap || pair.fdv || 0,
    priceChangePct: pair.priceChange?.h24 ?? 0,
  };

  console.log(`[DexScreener] $EMO: $${emo.priceUsd} | MC $${(emo.marketCapUsd / 1e3).toFixed(1)}K | ${emo.priceChangePct >= 0 ? '+' : ''}${emo.priceChangePct.toFixed(1)}%`);
  return emo;
}

async function main() {
  const [majors, nadfun, emo] = await Promise.all([
    fetchMajors().catch(e => { console.warn('CoinGecko failed:', e); return [] as DexTickerItem[]; }),
    fetchNadFun().catch(e => { console.warn('nad.fun failed:', e); return [] as NadFunTickerItem[]; }),
    fetchEmoDex().catch(e => { console.warn('DexScreener failed:', e); return null; }),
  ]);

  const data: TrendingData = {
    dex: majors,
    nadfun,
    emo,
    updatedAt: Date.now(),
  };

  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\nWritten ${STATE_FILE} with ${majors.length} majors + ${nadfun.length} nad.fun items`);
}

main().catch(console.error);
