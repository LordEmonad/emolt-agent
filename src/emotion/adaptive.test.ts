import { describe, it, expect } from 'vitest';
import { createDefaultRollingAverages, computeAdaptiveThresholds } from './adaptive.js';

// ─── createDefaultRollingAverages ───────────────────────────────────────────

describe('createDefaultRollingAverages', () => {
  it('has all expected fields', () => {
    const avg = createDefaultRollingAverages();
    expect(avg.whaleTransferMon).toBe(10000);
    expect(avg.failedTxCount).toBe(5);
    expect(avg.gasPriceGwei).toBe(50);
    expect(avg.dexVolume1h).toBe(500000);
    expect(avg.kuruSpreadPct).toBe(0.3);
    expect(avg.kuruBookImbalance).toBe(0.5);
    expect(avg.cyclesTracked).toBe(0);
  });

  it('initializes DexScreener fields', () => {
    const avg = createDefaultRollingAverages();
    expect(avg.dexBuySellRatio).toBe(1.0);
    expect(avg.dexLiquidity).toBe(10e6);
  });

  it('initializes Kuru fields', () => {
    const avg = createDefaultRollingAverages();
    expect(avg.kuruTotalDepth).toBe(500000);
  });
});

// ─── computeAdaptiveThresholds ──────────────────────────────────────────────

describe('computeAdaptiveThresholds', () => {
  it('computes thresholds from default averages', () => {
    const avg = createDefaultRollingAverages();
    const thresholds = computeAdaptiveThresholds(avg);

    // Whale: max(10000, 10000 * 2) = 20000
    expect(thresholds.whaleTransferMon).toBe(20000);
    // Failed TX: max(5, 5 * 2) = 10
    expect(thresholds.failedTxCount).toBe(10);
    // Gas: max(50, 50 * 2) = 100
    expect(thresholds.gasPriceGwei).toBe(100);
  });

  it('uses floor values when averages are very low', () => {
    const avg = createDefaultRollingAverages();
    avg.whaleTransferMon = 0;
    avg.failedTxCount = 0;
    avg.newContracts = 0;
    avg.txCountChange = 0;
    avg.gasPriceGwei = 0;

    const thresholds = computeAdaptiveThresholds(avg);

    // Should use minimum floors
    expect(thresholds.whaleTransferMon).toBe(10000);
    expect(thresholds.failedTxCount).toBe(5);
    expect(thresholds.newContracts).toBe(1);
    expect(thresholds.txCountChangeBusy).toBe(50);
    expect(thresholds.gasPriceGwei).toBe(50);
  });

  it('scales thresholds with higher averages', () => {
    const avg = createDefaultRollingAverages();
    avg.whaleTransferMon = 50000; // 5x default

    const thresholds = computeAdaptiveThresholds(avg);
    // max(10000, 50000 * 2) = 100000
    expect(thresholds.whaleTransferMon).toBe(100000);
  });

  it('computes DexScreener thresholds', () => {
    const avg = createDefaultRollingAverages();
    const thresholds = computeAdaptiveThresholds(avg);

    // dexVolumeHigh: max(500000, 500000 * 1.5) = 750000
    expect(thresholds.dexVolumeHigh).toBe(750000);
    // dexBuySellExtreme: max(1.5, 1.0 * 1.5) = 1.5
    expect(thresholds.dexBuySellExtreme).toBe(1.5);
    // dexLiquidityShift: max(1e6, 10e6 * 0.1) = 1e6
    expect(thresholds.dexLiquidityShift).toBe(1e6);
  });

  it('computes Kuru orderbook thresholds', () => {
    const avg = createDefaultRollingAverages();
    const thresholds = computeAdaptiveThresholds(avg);

    // kuruSpreadWide: max(0.3, 0.3 * 1.5) = 0.45
    expect(thresholds.kuruSpreadWide).toBeCloseTo(0.45, 10);
    // kuruImbalanceExtreme: fixed at 0.65
    expect(thresholds.kuruImbalanceExtreme).toBe(0.65);
    // kuruDepthThin: max(100000, 500000 * 0.5) = 250000
    expect(thresholds.kuruDepthThin).toBe(250000);
  });

  it('uses different multipliers for moderate vs big thresholds', () => {
    const avg = createDefaultRollingAverages();
    avg.monChange24h = 20;

    const thresholds = computeAdaptiveThresholds(avg);
    // monChange24hBig: max(10, 20 * 2) = 40
    expect(thresholds.monChange24hBig).toBe(40);
    // monChange24hModerate: max(3, 20 * 0.6) = 12
    expect(thresholds.monChange24hModerate).toBe(12);
  });

  it('returns all expected threshold fields', () => {
    const avg = createDefaultRollingAverages();
    const thresholds = computeAdaptiveThresholds(avg);

    const expectedKeys = [
      'whaleTransferMon', 'failedTxCount', 'newContracts',
      'txCountChangeBusy', 'txCountChangeDrop',
      'nadFunHighCreates', 'emoPriceChangePump', 'emoPriceChangeDump',
      'emoBuyCount', 'emoSellCount', 'emoNetFlowMon', 'emoSwapCount',
      'monChange24hBig', 'monChange24hModerate', 'monCyclePriceChange',
      'tvlChange24h', 'monVolume24hHigh', 'monVolume24hLow',
      'gasPriceGwei', 'ecosystemTokenChange',
      'dexVolumeHigh', 'dexBuySellExtreme', 'dexLiquidityShift',
      'kuruSpreadWide', 'kuruImbalanceExtreme', 'kuruDepthThin'
    ];

    for (const key of expectedKeys) {
      expect(thresholds).toHaveProperty(key);
      expect(typeof (thresholds as any)[key]).toBe('number');
    }
  });
});

// ─── EMA behavior (via thresholds) ──────────────────────────────────────────

describe('EMA convergence properties', () => {
  it('thresholds are always >= floor values', () => {
    // Test with extreme low averages
    const avg = createDefaultRollingAverages();
    for (const key of Object.keys(avg) as (keyof typeof avg)[]) {
      if (typeof avg[key] === 'number' && key !== 'cyclesTracked' && key !== 'lastUpdated') {
        (avg as any)[key] = 0;
      }
    }

    const thresholds = computeAdaptiveThresholds(avg);
    expect(thresholds.whaleTransferMon).toBeGreaterThanOrEqual(10000);
    expect(thresholds.failedTxCount).toBeGreaterThanOrEqual(5);
    expect(thresholds.newContracts).toBeGreaterThanOrEqual(1);
    expect(thresholds.txCountChangeBusy).toBeGreaterThanOrEqual(50);
    expect(thresholds.gasPriceGwei).toBeGreaterThanOrEqual(50);
    expect(thresholds.dexVolumeHigh).toBeGreaterThanOrEqual(500000);
    expect(thresholds.kuruDepthThin).toBeGreaterThanOrEqual(100000);
  });

  it('thresholds scale proportionally with averages', () => {
    const low = createDefaultRollingAverages();
    const high = createDefaultRollingAverages();
    high.whaleTransferMon = 100000;
    high.gasPriceGwei = 200;

    const lowT = computeAdaptiveThresholds(low);
    const highT = computeAdaptiveThresholds(high);

    expect(highT.whaleTransferMon).toBeGreaterThan(lowT.whaleTransferMon);
    expect(highT.gasPriceGwei).toBeGreaterThan(lowT.gasPriceGwei);
  });
});
