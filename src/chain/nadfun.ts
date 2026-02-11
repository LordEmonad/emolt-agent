import { createTrading, createDexIndexer, discoverPoolForToken } from '@nadfun/sdk';
import type { DexIndexer, PoolInfo } from '@nadfun/sdk';
import { type Address, erc20Abi, formatUnits } from 'viem';
import { publicClient, getAccount } from './client.js';
import type { NadFunContext, NadFunTokenInfo, EmoDexData, EmoSocialLinks } from './types.js';

const EMO_TOKEN: Address = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777';
const RPC_URL = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';

// nad.fun REST API — returns complete, accurate data in single HTTP calls
const NAD_FUN_API = 'https://api.nad.fun';

// Lazy singleton for $EMO SDK queries
let _trading: ReturnType<typeof createTrading> | null = null;

function getTrading() {
  if (!_trading) {
    const privateKey = (process.env.BURNER_PRIVATE_KEY || process.env.PRIVATE_KEY) as `0x${string}`;
    if (!privateKey) throw new Error('BURNER_PRIVATE_KEY or PRIVATE_KEY required for trading queries');
    _trading = createTrading({ rpcUrl: RPC_URL, privateKey, network: 'mainnet' });
  }
  return _trading;
}

// Simple circuit breaker: after 3 consecutive failures, skip for 1 cycle (30 min)
const circuitBreakers: Record<string, { failures: number; skipUntil: number }> = {};

function isCircuitOpen(name: string): boolean {
  const cb = circuitBreakers[name];
  if (!cb) return false;
  if (cb.failures >= 3 && Date.now() < cb.skipUntil) {
    console.warn(`[nad.fun] Circuit open for ${name}, skipping`);
    return true;
  }
  if (Date.now() >= cb.skipUntil) {
    cb.failures = 0;
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
    cb.skipUntil = Date.now() + 30 * 60 * 1000; // 30 min cooldown (1 cycle)
    console.warn(`[nad.fun] Circuit breaker tripped for ${name}, cooling down 30min`);
  }
  circuitBreakers[name] = cb;
}

// --- nad.fun REST API fetchers ---

interface NadFunApiToken {
  token_info: {
    token_id: string;        // token contract address
    name: string;
    symbol: string;
    created_at: number;      // Unix timestamp in seconds
    is_graduated: boolean;
    twitter?: string;
    telegram?: string;
    website?: string;
    hackathon_info?: unknown;
  };
  market_info: {
    market_type: string;     // "CURVE" or "DEX"
    token_id: string;
    market_id?: string;
    reserve_native?: string;
    reserve_token?: string;
    holder_count?: number;
    price_usd?: string;      // token price in USD
    price_native?: string;   // token price in MON
    total_supply?: string;   // total supply in wei (1e27 = 1B tokens)
  };
  percent: number;           // price change percentage
}

async function fetchNadFunEndpoint(endpoint: string): Promise<NadFunApiToken[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${NAD_FUN_API}${endpoint}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`nad.fun API HTTP ${res.status}`);
    const data = await res.json();
    // API returns { tokens: [...], total_count: N }
    return Array.isArray(data) ? data : (data.tokens ?? data.data ?? []);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNadFunTokensByCreation(): Promise<NadFunApiToken[]> {
  if (isCircuitOpen('nadFunCreation')) return [];
  try {
    const result = await fetchNadFunEndpoint('/order/creation_time?limit=100');
    recordSuccess('nadFunCreation');
    return result;
  } catch (error) {
    recordFailure('nadFunCreation');
    console.warn('[nad.fun] Failed to fetch by creation_time:', error);
    return [];
  }
}

async function fetchNadFunTokensByMarketCap(): Promise<NadFunApiToken[]> {
  if (isCircuitOpen('nadFunMarketCap')) return [];
  try {
    const result = await fetchNadFunEndpoint('/order/market_cap?limit=100');
    recordSuccess('nadFunMarketCap');
    return result;
  } catch (error) {
    recordFailure('nadFunMarketCap');
    console.warn('[nad.fun] Failed to fetch by market_cap:', error);
    return [];
  }
}

// Direct viem reads for token info - avoids SDK's multicall3 dependency
async function getEmoBalance(address: Address): Promise<string> {
  const raw = await publicClient.readContract({
    address: EMO_TOKEN,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  const decimals = await publicClient.readContract({
    address: EMO_TOKEN,
    abi: erc20Abi,
    functionName: 'decimals',
  });
  return formatUnits(raw, decimals);
}

// --- EMO DEX tracking state ---
let _cachedPoolAddress: Address | null = null;
let _dexIndexer: DexIndexer | null = null;
let _cachedSocialLinks: EmoSocialLinks | null = null;
let _previousEmoPrice: number = 0;

const WMON_ADDRESS: Address = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701';

async function getEmoDexIndexer(): Promise<DexIndexer> {
  if (_dexIndexer) return _dexIndexer;

  // Discover the pool address
  if (!_cachedPoolAddress) {
    const pool = await discoverPoolForToken(RPC_URL, EMO_TOKEN, 'mainnet');
    if (!pool) throw new Error('No DEX pool found for $EMO');
    _cachedPoolAddress = pool;
    console.log(`[EMO DEX] Discovered pool: ${pool}`);
  }

  _dexIndexer = createDexIndexer({
    rpcUrl: RPC_URL,
    pools: [_cachedPoolAddress],
    network: 'mainnet',
  });
  return _dexIndexer;
}

function calculatePriceFromSqrtPriceX96(sqrtPriceX96: bigint, emoIsToken0: boolean): number {
  // sqrtPriceX96 encodes (token1 per token0). Both tokens 18 decimals - no adjustment needed.
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const price = sqrtPrice * sqrtPrice;
  if (emoIsToken0) {
    return price; // already WMON per EMO
  } else {
    return price > 0 ? 1 / price : 0; // invert: was EMO per WMON, need WMON per EMO
  }
}

// DexScreener API - faster and more reliable than eth_getLogs scanning
const DEXSCREENER_POOL_URL = `https://api.dexscreener.com/latest/dex/pairs/monad/`;

export async function collectEmoDexData(
  _fromBlock: bigint,
  _toBlock: bigint,
  monPriceUsd: number
): Promise<EmoDexData | null> {
  try {
    // Discover pool address if not cached
    if (!_cachedPoolAddress) {
      const pool = await discoverPoolForToken(RPC_URL, EMO_TOKEN, 'mainnet');
      if (!pool) throw new Error('No DEX pool found for $EMO');
      _cachedPoolAddress = pool;
      console.log(`[EMO DEX] Discovered pool: ${pool}`);
    }
    const poolAddress = _cachedPoolAddress;

    // Fetch from DexScreener - single API call, complete data
    const res = await fetch(`${DEXSCREENER_POOL_URL}${poolAddress}`);
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const json = await res.json();
    const pair = json.pair || json.pairs?.[0];
    if (!pair) throw new Error('No pair data from DexScreener');

    const priceMon = parseFloat(pair.priceNative) || 0;
    const priceUsd = parseFloat(pair.priceUsd) || priceMon * monPriceUsd;

    // Price change vs previous cycle
    const priceChangePercent = _previousEmoPrice > 0
      ? ((priceMon - _previousEmoPrice) / _previousEmoPrice) * 100
      : 0;
    _previousEmoPrice = priceMon;

    // DexScreener provides 1h and 24h stats - use 1h as the per-cycle metric
    const buyCount = pair.txns?.h1?.buys ?? 0;
    const sellCount = pair.txns?.h1?.sells ?? 0;
    const volumeUsd1h = parseFloat(pair.volume?.h1) || 0;
    const volumeMon1h = monPriceUsd > 0 ? volumeUsd1h / monPriceUsd : 0;

    // Estimate buy/sell volume split from counts
    const totalTxns = buyCount + sellCount;
    const buyRatio = totalTxns > 0 ? buyCount / totalTxns : 0.5;
    const volumeMonBuys = volumeMon1h * buyRatio;
    const volumeMonSells = volumeMon1h * (1 - buyRatio);

    const emoIsToken0 = (pair.baseToken?.address || '').toLowerCase() === EMO_TOKEN.toLowerCase();
    const liquidity = pair.liquidity?.usd?.toString() || '0';

    return {
      poolAddress,
      emoIsToken0,
      priceMon,
      priceUsd,
      liquidity,
      swapCount: totalTxns,
      buyCount,
      sellCount,
      volumeMonBuys,
      volumeMonSells,
      netFlowMon: volumeMonBuys - volumeMonSells,
      priceChangePercent,
    };
  } catch (error) {
    console.warn('[EMO DEX] DexScreener failed, trying on-chain fallback:', error);
    // Fallback: use on-chain pool info for price only (no swap data)
    return collectEmoDexDataOnChain(monPriceUsd);
  }
}

// On-chain fallback: just gets price from pool, no swap history
async function collectEmoDexDataOnChain(monPriceUsd: number): Promise<EmoDexData | null> {
  try {
    const indexer = await getEmoDexIndexer();
    const poolAddress = _cachedPoolAddress!;
    const poolInfo: PoolInfo = await indexer.getPoolInfo(poolAddress);
    const emoIsToken0 = poolInfo.token0.toLowerCase() === EMO_TOKEN.toLowerCase();
    const priceMon = calculatePriceFromSqrtPriceX96(poolInfo.sqrtPriceX96, emoIsToken0);
    const priceUsd = priceMon * monPriceUsd;

    const priceChangePercent = _previousEmoPrice > 0
      ? ((priceMon - _previousEmoPrice) / _previousEmoPrice) * 100
      : 0;
    _previousEmoPrice = priceMon;

    return {
      poolAddress,
      emoIsToken0,
      priceMon,
      priceUsd,
      liquidity: poolInfo.liquidity.toString(),
      swapCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeMonBuys: 0,
      volumeMonSells: 0,
      netFlowMon: 0,
      priceChangePercent,
    };
  } catch (error) {
    console.warn('[EMO DEX] On-chain fallback also failed:', error);
    return null;
  }
}

export async function fetchEmoSocialLinks(): Promise<EmoSocialLinks | null> {
  if (_cachedSocialLinks) return _cachedSocialLinks;

  try {
    // Read tokenURI from the EMO contract
    const tokenURI = await publicClient.readContract({
      address: EMO_TOKEN,
      abi: [{ name: 'tokenURI', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const,
      functionName: 'tokenURI',
    });

    if (!tokenURI) return null;

    // Handle data URIs (base64 JSON) or HTTP URIs
    let metadata: any;
    if (tokenURI.startsWith('data:application/json;base64,')) {
      const base64 = tokenURI.replace('data:application/json;base64,', '');
      metadata = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    } else if (tokenURI.startsWith('data:application/json,')) {
      metadata = JSON.parse(tokenURI.replace('data:application/json,', ''));
    } else if (tokenURI.startsWith('http')) {
      const res = await fetch(tokenURI);
      metadata = await res.json();
    } else {
      // Try IPFS or other scheme
      const ipfsUrl = tokenURI.startsWith('ipfs://') ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/') : tokenURI;
      const res = await fetch(ipfsUrl);
      metadata = await res.json();
    }

    _cachedSocialLinks = {
      website: metadata.website || metadata.external_url || null,
      twitter: metadata.twitter || metadata.twitter_url || (metadata.socials?.twitter) || null,
      telegram: metadata.telegram || metadata.telegram_url || (metadata.socials?.telegram) || null,
      description: metadata.description || null,
    };

    console.log(`[EMO DEX] Social links loaded: ${JSON.stringify(_cachedSocialLinks)}`);
    return _cachedSocialLinks;
  } catch (error) {
    console.warn('[EMO DEX] Failed to fetch social links:', error);
    return null;
  }
}

export async function collectNadFunData(): Promise<NadFunContext> {
  let agentAddress: Address | undefined;
  try {
    agentAddress = getAccount().address;
  } catch {
    // No private key - skip balance check
  }

  // Cycle cutoff: tokens created in the last 30 minutes
  const cycleCutoffMs = Date.now() - 30 * 60 * 1000;

  // Collect API data + $EMO SDK queries in parallel
  const [creationTokens, marketCapTokens, emoProgress, emoGraduated, emoBalance] =
    await Promise.all([
      fetchNadFunTokensByCreation(),
      fetchNadFunTokensByMarketCap(),
      getTrading().getProgress(EMO_TOKEN).catch(() => 10000n),
      getTrading().isGraduated(EMO_TOKEN).catch(() => true),
      agentAddress
        ? getEmoBalance(agentAddress).catch(() => '0')
        : Promise.resolve('0'),
    ]);

  // Count creates: tokens created within this cycle window
  // created_at is Unix seconds — multiply by 1000 to compare with JS ms timestamps
  const creates = creationTokens.filter(t => {
    const createdAtMs = t.token_info.created_at * 1000;
    return createdAtMs >= cycleCutoffMs;
  }).length;

  // Count graduations: tokens that graduated AND were created recently
  const graduations = creationTokens.filter(t => {
    const createdAtMs = t.token_info.created_at * 1000;
    return t.token_info.is_graduated && createdAtMs >= cycleCutoffMs;
  }).length;

  // Trending tokens: top 5 non-graduated by market cap, fetch actual bonding curve progress
  const trendingCandidates = marketCapTokens
    .filter(t => !t.token_info.is_graduated)
    .slice(0, 5);

  const trendingTokens: NadFunTokenInfo[] = await Promise.all(
    trendingCandidates.map(async (t) => {
      const tokenAddr = t.token_info.token_id as Address;
      const progress = await getTrading().getProgress(tokenAddr).catch(() => 0n);
      const priceUsd = parseFloat(t.market_info.price_usd || '0');
      const priceNative = parseFloat(t.market_info.price_native || '0');
      // total_supply is in wei (18 decimals), typically 1e27 = 1B tokens
      const totalSupply = t.market_info.total_supply
        ? Number(BigInt(t.market_info.total_supply)) / 1e18
        : 1e9;
      const marketCapUsd = priceUsd * totalSupply;
      return {
        address: t.token_info.token_id,
        name: t.token_info.name || 'Unknown',
        symbol: t.token_info.symbol || '???',
        progress: Number(progress),
        isGraduated: false,
        priceUsd,
        priceNative,
        marketCapUsd,
        priceChangePct: t.percent ?? 0,
      };
    })
  );

  // Recent graduates: graduated tokens from market cap list
  const recentGraduates = marketCapTokens
    .filter(t => t.token_info.is_graduated)
    .slice(0, 5)
    .map(t => ({
      address: t.token_info.token_id,
      name: t.token_info.name || t.token_info.token_id.slice(0, 10),
    }));

  console.log(`[nad.fun] API data: ${creates} creates, ${graduations} graduations, ${trendingTokens.length} trending, ${recentGraduates.length} graduates`);

  return {
    creates,
    graduations,
    trendingTokens,
    recentGraduates,
    emoToken: {
      progress: Number(emoProgress),
      graduated: emoGraduated,
      balance: emoBalance,
      dex: null,
      socialLinks: null,
    },
  };
}
