import { createCurveIndexer, createTrading, createDexIndexer, discoverPoolForToken } from '@nadfun/sdk';
import type { DexIndexer, PoolInfo } from '@nadfun/sdk';
import { type Address, erc20Abi, formatUnits } from 'viem';
import { publicClient, getAccount } from './client.js';
import type { NadFunContext, NadFunTokenInfo, EmoDexData, EmoSocialLinks } from './types.js';

const EMO_TOKEN: Address = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777';
const RPC_URL = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';

// Monad RPC limits eth_getLogs to 100 blocks per call
const MAX_LOG_RANGE = 100n;

// Lazy singletons
let _indexer: ReturnType<typeof createCurveIndexer> | null = null;
let _trading: ReturnType<typeof createTrading> | null = null;

function getIndexer() {
  if (!_indexer) {
    _indexer = createCurveIndexer({ rpcUrl: RPC_URL, network: 'mainnet' });
  }
  return _indexer;
}

function getTrading() {
  if (!_trading) {
    const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
    if (!privateKey) throw new Error('PRIVATE_KEY required for trading queries');
    _trading = createTrading({ rpcUrl: RPC_URL, privateKey, network: 'mainnet' });
  }
  return _trading;
}

// Chunk a large block range into 100-block windows for eth_getLogs compliance
async function getCreateEventsChunked(fromBlock: bigint, toBlock: bigint) {
  const indexer = getIndexer();
  const allEvents: Awaited<ReturnType<typeof indexer.getCreateEvents>> = [];

  // Sample up to 10 chunks spread across the range (not every chunk - too many RPC calls)
  const totalRange = toBlock - fromBlock;
  const numChunks = Math.min(10, Number(totalRange / MAX_LOG_RANGE) + 1);
  const step = totalRange / BigInt(numChunks);

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = fromBlock + step * BigInt(i);
    const chunkEnd = chunkStart + MAX_LOG_RANGE < toBlock ? chunkStart + MAX_LOG_RANGE : toBlock;
    try {
      const events = await indexer.getCreateEvents(chunkStart, chunkEnd);
      allEvents.push(...events);
    } catch {
      // Skip failed chunks
    }
  }

  return allEvents;
}

async function getGraduateEventsChunked(fromBlock: bigint, toBlock: bigint) {
  const indexer = getIndexer();
  const allEvents: Awaited<ReturnType<typeof indexer.getGraduateEvents>> = [];

  const totalRange = toBlock - fromBlock;
  const numChunks = Math.min(10, Number(totalRange / MAX_LOG_RANGE) + 1);
  const step = totalRange / BigInt(numChunks);

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = fromBlock + step * BigInt(i);
    const chunkEnd = chunkStart + MAX_LOG_RANGE < toBlock ? chunkStart + MAX_LOG_RANGE : toBlock;
    try {
      const events = await indexer.getGraduateEvents(chunkStart, chunkEnd);
      allEvents.push(...events);
    } catch {
      // Skip failed chunks
    }
  }

  return allEvents;
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

async function getTokenName(token: Address): Promise<string> {
  try {
    return await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'name',
    });
  } catch {
    try {
      return await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      });
    } catch {
      return token.slice(0, 10);
    }
  }
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

export async function collectNadFunData(
  fromBlock: bigint,
  toBlock: bigint
): Promise<NadFunContext> {
  let agentAddress: Address | undefined;
  try {
    agentAddress = getAccount().address;
  } catch {
    // No private key - skip balance check
  }

  // Collect everything in parallel
  const [createEvents, graduateEvents, emoProgress, emoGraduated, emoBalance] =
    await Promise.all([
      getCreateEventsChunked(fromBlock, toBlock).catch(() => []),
      getGraduateEventsChunked(fromBlock, toBlock).catch(() => []),
      getTrading().getProgress(EMO_TOKEN).catch(() => 10000n),
      getTrading().isGraduated(EMO_TOKEN).catch(() => true),
      agentAddress
        ? getEmoBalance(agentAddress).catch(() => '0')
        : Promise.resolve('0'),
    ]);

  const creates = createEvents.length;
  const graduations = graduateEvents.length;

  // Build recent graduates list - use direct viem reads for names
  const recentGraduates: { address: string; name: string }[] = [];
  for (const evt of graduateEvents.slice(0, 5)) {
    const name = await getTokenName(evt.token).catch(() => evt.token.slice(0, 10));
    recentGraduates.push({ address: evt.token, name });
  }

  // Build trending list from recently created tokens
  const trendingTokens: NadFunTokenInfo[] = [];
  if (createEvents.length > 0) {
    const tokensToCheck = createEvents.slice(-10);
    const tokenInfos: NadFunTokenInfo[] = [];

    for (const evt of tokensToCheck) {
      try {
        const [progress, graduated] = await Promise.all([
          getTrading().getProgress(evt.token).catch(() => 0n),
          getTrading().isGraduated(evt.token).catch(() => false),
        ]);
        tokenInfos.push({
          address: evt.token,
          name: evt.name || 'Unknown',
          symbol: evt.symbol || '???',
          progress: Number(progress),
          isGraduated: graduated,
        });
      } catch {
        // Skip tokens we can't query
      }
    }

    tokenInfos.sort((a, b) => b.progress - a.progress);
    trendingTokens.push(...tokenInfos.slice(0, 5));
  }

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
