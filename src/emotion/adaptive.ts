import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import type { RollingAverages, AdaptiveThresholds } from './types.js';
import type { ChainDataSummary, EcosystemData, EmoDexData, DexScreenerMarketData, KuruOrderbookData } from '../chain/types.js';
import type { PriceData } from './types.js';

const ROLLING_AVG_FILE = join(STATE_DIR, 'rolling-averages.json');
const EMA_ALPHA = 0.1;

export function createDefaultRollingAverages(): RollingAverages {
  return {
    whaleTransferMon: 10000,
    failedTxCount: 5,
    newContracts: 1,
    txCountChange: 50,
    nadFunCreates: 10,
    nadFunGraduations: 3,
    emoPriceChangePercent: 10,
    emoBuyCount: 5,
    emoSellCount: 5,
    emoNetFlowMon: 10,
    emoSwapCount: 20,
    monChange24h: 10,
    monCyclePriceChange: 3,
    tvlChange24h: 5,
    monadTVL: 500e6,
    monVolume24h: 50e6,
    gasPriceGwei: 50,
    ecosystemTokenChange: 20,
    dexVolume1h: 500000,
    dexBuySellRatio: 1.0,
    dexLiquidity: 10e6,
    kuruSpreadPct: 0.3,
    kuruBookImbalance: 0.5,
    kuruTotalDepth: 500000,
    cyclesTracked: 0,
    lastUpdated: Date.now(),
  };
}

export function loadRollingAverages(): RollingAverages {
  try {
    const data = readFileSync(ROLLING_AVG_FILE, 'utf-8');
    const loaded = JSON.parse(data);
    // Merge with defaults so old state files get new fields
    return Object.assign(createDefaultRollingAverages(), loaded);
  } catch {
    return createDefaultRollingAverages();
  }
}

export function saveRollingAverages(avg: RollingAverages): void {
  ensureStateDir();
  avg.lastUpdated = Date.now();
  atomicWriteFileSync(ROLLING_AVG_FILE, JSON.stringify(avg, null, 2));
}

function ema(current: number, observed: number): number {
  return current * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
}

export function updateRollingAverages(
  avg: RollingAverages,
  chainData: ChainDataSummary,
  priceData?: PriceData,
  ecosystemData?: EcosystemData | null,
  emoDexData?: EmoDexData | null,
  dexData?: DexScreenerMarketData | null,
  kuruData?: KuruOrderbookData | null,
): RollingAverages {
  const updated = { ...avg };

  // Chain data
  const maxWhale = chainData.largeTransfers.length > 0
    ? Math.max(...chainData.largeTransfers.map(t => Number(t.value) / 1e18))
    : 0;
  updated.whaleTransferMon = ema(avg.whaleTransferMon, maxWhale);
  updated.failedTxCount = ema(avg.failedTxCount, chainData.failedTxCount);
  updated.newContracts = ema(avg.newContracts, chainData.newContracts);
  updated.txCountChange = ema(avg.txCountChange, Math.abs(chainData.txCountChange));

  // nad.fun
  if (chainData.nadFunContext) {
    updated.nadFunCreates = ema(avg.nadFunCreates, chainData.nadFunContext.creates);
    updated.nadFunGraduations = ema(avg.nadFunGraduations, chainData.nadFunContext.graduations);
  }

  // EMO DEX
  if (emoDexData) {
    updated.emoPriceChangePercent = ema(avg.emoPriceChangePercent, Math.abs(emoDexData.priceChangePercent));
    updated.emoBuyCount = ema(avg.emoBuyCount, emoDexData.buyCount);
    updated.emoSellCount = ema(avg.emoSellCount, emoDexData.sellCount);
    updated.emoNetFlowMon = ema(avg.emoNetFlowMon, Math.abs(emoDexData.netFlowMon));
    updated.emoSwapCount = ema(avg.emoSwapCount, emoDexData.swapCount);
  }

  // Price
  if (priceData) {
    updated.monChange24h = ema(avg.monChange24h, Math.abs(priceData.change24h));
    updated.monCyclePriceChange = ema(avg.monCyclePriceChange, Math.abs(priceData.cyclePriceChange));
  }

  // Ecosystem
  if (ecosystemData?.dataAvailable) {
    updated.tvlChange24h = ema(avg.tvlChange24h, Math.abs(ecosystemData.tvlChange24h));
    updated.monadTVL = ema(avg.monadTVL, ecosystemData.monadTVL);
    updated.monVolume24h = ema(avg.monVolume24h, ecosystemData.monVolume24h);
    updated.gasPriceGwei = ema(avg.gasPriceGwei, ecosystemData.gasPriceGwei);
    if (ecosystemData.ecosystemTokens.length > 0) {
      const maxChange = Math.max(...ecosystemData.ecosystemTokens.map(t => Math.abs(t.change24h)));
      updated.ecosystemTokenChange = ema(avg.ecosystemTokenChange, maxChange);
    }
  }

  // DexScreener
  if (dexData?.dataAvailable) {
    updated.dexVolume1h = ema(avg.dexVolume1h, dexData.totalVolume1h);
    updated.dexBuySellRatio = ema(avg.dexBuySellRatio, dexData.buySellRatio);
    updated.dexLiquidity = ema(avg.dexLiquidity, dexData.totalLiquidity);
  }

  // Kuru Orderbook
  if (kuruData?.dataAvailable) {
    updated.kuruSpreadPct = ema(avg.kuruSpreadPct, kuruData.spreadPct);
    updated.kuruBookImbalance = ema(avg.kuruBookImbalance, kuruData.bookImbalance);
    updated.kuruTotalDepth = ema(avg.kuruTotalDepth, kuruData.bidDepthMon + kuruData.askDepthMon);
  }

  updated.cyclesTracked++;
  return updated;
}

export function computeAdaptiveThresholds(avg: RollingAverages): AdaptiveThresholds {
  return {
    whaleTransferMon: Math.max(10000, avg.whaleTransferMon * 2),
    failedTxCount: Math.max(5, avg.failedTxCount * 2),
    newContracts: Math.max(1, avg.newContracts * 2),
    txCountChangeBusy: Math.max(50, avg.txCountChange * 2),
    txCountChangeDrop: Math.max(30, avg.txCountChange * 1.5),
    nadFunHighCreates: Math.max(10, avg.nadFunCreates * 2),
    emoPriceChangePump: Math.max(10, avg.emoPriceChangePercent * 2),
    emoPriceChangeDump: Math.max(10, avg.emoPriceChangePercent * 2),
    emoBuyCount: Math.max(5, avg.emoBuyCount * 2),
    emoSellCount: Math.max(5, avg.emoSellCount * 2),
    emoNetFlowMon: Math.max(10, avg.emoNetFlowMon * 2),
    emoSwapCount: Math.max(20, avg.emoSwapCount * 2),
    monChange24hBig: Math.max(10, avg.monChange24h * 2),
    monChange24hModerate: Math.max(3, avg.monChange24h * 0.6),
    monCyclePriceChange: Math.max(3, avg.monCyclePriceChange * 2),
    tvlChange24h: Math.max(5, avg.tvlChange24h * 2),
    monVolume24hHigh: Math.max(50e6, avg.monVolume24h * 2),
    monVolume24hLow: Math.max(5e6, avg.monVolume24h * 0.2),
    gasPriceGwei: Math.max(50, avg.gasPriceGwei * 2),
    ecosystemTokenChange: Math.max(20, avg.ecosystemTokenChange * 2),
    // DexScreener
    dexVolumeHigh: Math.max(500000, avg.dexVolume1h * 1.5),
    dexBuySellExtreme: Math.max(1.5, avg.dexBuySellRatio * 1.5),
    dexLiquidityShift: Math.max(1e6, avg.dexLiquidity * 0.1), // 10% of avg liquidity as "shift" threshold
    // Kuru Orderbook
    kuruSpreadWide: Math.max(0.3, avg.kuruSpreadPct * 1.5),
    kuruImbalanceExtreme: 0.65, // fixed: >0.65 bid-heavy, <0.35 ask-heavy
    kuruDepthThin: Math.max(100000, avg.kuruTotalDepth * 0.5), // depth below 50% of average
  };
}
