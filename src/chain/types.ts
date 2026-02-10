export interface BlockSnapshot {
  blockNumber: bigint;
  timestamp: number;
  transactionCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
}

export interface NadFunTokenInfo {
  address: string;
  name: string;
  symbol: string;
  progress: number; // 0-10000 (basis points, 10000 = 100%)
  isGraduated: boolean;
  priceUsd: number;        // token price in USD from API
  priceNative: number;     // token price in MON from API
  marketCapUsd: number;    // price_usd * total_supply
  priceChangePct: number;  // price change % from API
}

export interface EmoDexData {
  poolAddress: string;
  emoIsToken0: boolean;
  priceMon: number;           // EMO price in MON
  priceUsd: number;           // EMO price in USD
  liquidity: string;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  volumeMonBuys: number;
  volumeMonSells: number;
  netFlowMon: number;         // positive = net buying
  priceChangePercent: number;  // vs previous cycle
}

export interface EmoSocialLinks {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string | null;
}

export interface NadFunContext {
  creates: number;
  graduations: number;
  trendingTokens: NadFunTokenInfo[]; // top 5 by progress
  recentGraduates: { address: string; name: string }[];
  emoToken: {
    progress: number;
    graduated: boolean;
    balance: string; // formatted balance
    dex: EmoDexData | null;
    socialLinks: EmoSocialLinks | null;
  };
}

export interface LargeTransfer {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  blockNumber: bigint;
}

// Results from a single-pass block scan
export interface BlockScanResults {
  largeTransfers: LargeTransfer[];
  failedTxCount: number;
  newContracts: number;
  uniqueAddresses: Set<string>;
  totalValueMoved: bigint;       // total MON transferred across all txs
  contractInteractions: number;  // txs that call contracts (input.length > 10)
  simpleTransfers: number;       // txs that just send MON (no calldata)
  maxSingleTxValue: bigint;      // biggest single tx
  txsScanned: number;            // total individual txs examined
}

export interface ChainDataSummary {
  periodStart: number;
  periodEnd: number;
  blocksObserved: number;

  // Transaction stats
  avgTransactionsPerBlock: number;
  totalTransactions: number;
  txCountChange: number; // % change from previous period

  // Gas stats
  avgGasUsed: bigint;
  gasUtilization: number; // gasUsed / gasLimit ratio
  avgGasChange: number; // % change from previous period

  // Events
  largeTransfers: LargeTransfer[];
  failedTxCount: number;
  newContracts: number;

  // New metrics from single-pass scan
  uniqueActiveAddresses: number;   // unique sender addresses seen
  totalVolumeMonMoved: number;     // total MON transferred (as float)
  contractInteractionRatio: number; // 0-1, what % of txs are contract calls
  avgTxValue: number;              // average MON per transaction
  maxSingleTxValue: number;        // biggest individual tx in MON

  // nad.fun
  nadFunCreates: number;
  nadFunGraduations: number;
  nadFunContext: NadFunContext | null;

  // Activity flags
  isChainQuiet: boolean;
  isChainBusy: boolean;
}

// Broader ecosystem data from external APIs
export interface EcosystemData {
  // DefiLlama
  monadTVL: number;              // total Monad TVL in USD
  tvlChange24h: number;          // % change in TVL over 24h
  topProtocols: { name: string; tvl: number }[]; // top 5 protocols by TVL

  // CoinGecko expanded
  monMarketCap: number;          // USD
  monVolume24h: number;          // USD trading volume
  monCirculatingSupply: number;
  monMarketCapRank: number;

  // Monad ecosystem tokens (top movers)
  ecosystemTokens: {
    name: string;
    symbol: string;
    price: number;
    change24h: number;
  }[];

  // Gas from RPC
  gasPriceGwei: number;          // current gas price

  // Metadata
  fetchedAt: number;
  dataAvailable: boolean;        // false if all fetches failed
}
