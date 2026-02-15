import { parseEther } from 'viem';
import { publicClient, getAccount } from './client.js';
import { collectNadFunData } from './nadfun.js';
import type { BlockSnapshot, LargeTransfer, ChainDataSummary, NadFunContext, BlockScanResults } from './types.js';

const WHALE_THRESHOLD = parseEther('10000'); // 10K MON

export async function getBlockSnapshot(): Promise<BlockSnapshot> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  return {
    blockNumber: block.number,
    timestamp: Number(block.timestamp),
    transactionCount: block.transactions.length,
    gasUsed: block.gasUsed,
    gasLimit: block.gasLimit
  };
}

// Single-pass block scanner - fetches blocks once and extracts all metrics
export async function scanBlocks(fromBlock: bigint, toBlock: bigint): Promise<BlockScanResults> {
  const results: BlockScanResults = {
    largeTransfers: [],
    failedTxCount: 0,
    newContracts: 0,
    uniqueAddresses: new Set<string>(),
    totalValueMoved: 0n,
    contractInteractions: 0,
    simpleTransfers: 0,
    maxSingleTxValue: 0n,
    txsScanned: 0,
    incomingNativeTransfers: []
  };

  // Agent address for detecting incoming transfers
  let agentAddr: string | null = null;
  try {
    agentAddr = getAccount().address.toLowerCase();
  } catch { /* no private key — skip incoming detection */ }

  // Adaptive sampling: denser for recent blocks, sparser for older ones
  // Recent 25% of range: every 25 blocks, older 75%: every 100 blocks
  const range = toBlock - fromBlock;
  const recentStart = toBlock - range / 4n;
  const maxBlocks = 150n;
  let checked = 0n;

  // Build sample points: sparse old blocks, dense recent blocks
  const samplePoints: bigint[] = [];
  for (let bn = fromBlock; bn < recentStart && samplePoints.length < 75; bn += 50n) {
    samplePoints.push(bn);
  }
  for (let bn = recentStart; bn <= toBlock && samplePoints.length < 150; bn += 15n) {
    samplePoints.push(bn);
  }

  for (const bn of samplePoints) {
    if (checked >= maxBlocks) break;
    try {
      const block = await publicClient.getBlock({ blockNumber: bn, includeTransactions: true });

      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue;

        results.txsScanned++;

        // Track unique senders
        results.uniqueAddresses.add(tx.from.toLowerCase());

        // Track value
        results.totalValueMoved += tx.value;
        if (tx.value > results.maxSingleTxValue) {
          results.maxSingleTxValue = tx.value;
        }

        // Whale transfers
        if (tx.value >= WHALE_THRESHOLD) {
          results.largeTransfers.push({
            from: tx.from,
            to: tx.to || 'contract_creation',
            value: tx.value,
            txHash: tx.hash,
            blockNumber: bn
          });
        }

        // Contract creation
        if (tx.to === null) {
          results.newContracts++;
        }

        // Contract interaction vs simple transfer
        // Function selector = 4 bytes = "0x" + 8 hex chars = 10 chars minimum
        if (tx.input && tx.input.length > 10) {
          results.contractInteractions++;
        } else {
          results.simpleTransfers++;
        }

        // Incoming native MON transfers to agent wallet
        if (agentAddr && tx.to?.toLowerCase() === agentAddr && tx.value > 0n) {
          results.incomingNativeTransfers.push({
            from: tx.from,
            value: tx.value,
            txHash: tx.hash,
            blockNumber: bn
          });
        }
      }

      checked++;
    } catch {
      // Skip blocks we can't fetch
    }
  }

  // Sample a few receipts for failed tx detection (expensive, so do fewer)
  // Pick up to 15 random txs from the scanned data to check receipts
  if (results.largeTransfers.length > 0 || results.txsScanned > 0) {
    // Check receipts from a small sample of blocks
    const receiptSampleInterval = 300n;
    let receiptChecked = 0n;
    for (let bn = fromBlock; bn <= toBlock && receiptChecked < 10n; bn += receiptSampleInterval) {
      try {
        const block = await publicClient.getBlock({ blockNumber: bn, includeTransactions: true });
        // Check first 3 txs per sampled block
        for (const tx of block.transactions.slice(0, 3)) {
          if (typeof tx !== 'string') {
            try {
              const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash });
              if (receipt.status === 'reverted') results.failedTxCount++;
            } catch {
              // Skip
            }
          }
        }
        receiptChecked++;
      } catch {
        // Skip
      }
    }
  }

  return results;
}

export function aggregateSnapshots(
  snapshots: BlockSnapshot[],
  previousSummary: ChainDataSummary | null,
  scanResults: BlockScanResults,
  nadFunContext: NadFunContext | null = null
): ChainDataSummary {
  const emptyResult: ChainDataSummary = {
    periodStart: Date.now(),
    periodEnd: Date.now(),
    blocksObserved: 0,
    avgTransactionsPerBlock: 0,
    totalTransactions: 0,
    txCountChange: 0,
    avgGasUsed: 0n,
    gasUtilization: 0,
    avgGasChange: 0,
    largeTransfers: scanResults.largeTransfers,
    failedTxCount: scanResults.failedTxCount,
    newContracts: scanResults.newContracts,
    uniqueActiveAddresses: scanResults.uniqueAddresses.size,
    totalVolumeMonMoved: Number(scanResults.totalValueMoved) / 1e18,
    contractInteractionRatio: 0,
    avgTxValue: 0,
    maxSingleTxValue: Number(scanResults.maxSingleTxValue) / 1e18,
    nadFunCreates: nadFunContext?.creates ?? 0,
    nadFunGraduations: nadFunContext?.graduations ?? 0,
    nadFunContext,
    isChainQuiet: true,
    isChainBusy: false,
    incomingNativeTransfers: scanResults.incomingNativeTransfers
  };

  if (snapshots.length === 0) return emptyResult;

  const avgTx = snapshots.reduce((sum, s) => sum + s.transactionCount, 0) / snapshots.length;
  const prevAvgTx = previousSummary?.avgTransactionsPerBlock || avgTx;

  const totalGasUsed = snapshots.reduce((sum, s) => sum + s.gasUsed, 0n);
  const totalGasLimit = snapshots.reduce((sum, s) => sum + s.gasLimit, 0n);
  const avgGas = totalGasUsed / BigInt(snapshots.length);

  const totalTxsInScan = scanResults.contractInteractions + scanResults.simpleTransfers;
  const contractRatio = totalTxsInScan > 0 ? scanResults.contractInteractions / totalTxsInScan : 0;
  const totalVolumeMon = Number(scanResults.totalValueMoved) / 1e18;
  const avgTxVal = scanResults.txsScanned > 0 ? totalVolumeMon / scanResults.txsScanned : 0;

  return {
    periodStart: snapshots[0].timestamp,
    periodEnd: snapshots[snapshots.length - 1].timestamp,
    blocksObserved: snapshots.length,
    avgTransactionsPerBlock: avgTx,
    totalTransactions: snapshots.reduce((sum, s) => sum + s.transactionCount, 0),
    txCountChange: prevAvgTx > 0 ? ((avgTx - prevAvgTx) / prevAvgTx) * 100 : 0,
    avgGasUsed: avgGas,
    gasUtilization: totalGasLimit > 0n ? Number(totalGasUsed) / Number(totalGasLimit) : 0,
    avgGasChange: previousSummary && previousSummary.avgGasUsed > 0n
      ? ((Number(avgGas) - Number(previousSummary.avgGasUsed)) / Number(previousSummary.avgGasUsed)) * 100
      : 0,
    largeTransfers: scanResults.largeTransfers,
    failedTxCount: scanResults.failedTxCount,
    newContracts: scanResults.newContracts,
    uniqueActiveAddresses: scanResults.uniqueAddresses.size,
    totalVolumeMonMoved: totalVolumeMon,
    contractInteractionRatio: contractRatio,
    avgTxValue: avgTxVal,
    maxSingleTxValue: Number(scanResults.maxSingleTxValue) / 1e18,
    nadFunCreates: nadFunContext?.creates ?? 0,
    nadFunGraduations: nadFunContext?.graduations ?? 0,
    nadFunContext,
    isChainQuiet: avgTx < prevAvgTx * 0.5,
    isChainBusy: avgTx > prevAvgTx * 1.5,
    incomingNativeTransfers: scanResults.incomingNativeTransfers
  };
}

export async function collectChainData(previousSummary: ChainDataSummary | null): Promise<ChainDataSummary> {
  try {
    // Get current block
    const currentSnapshot = await getBlockSnapshot();
    const currentBlock = currentSnapshot.blockNumber;

    // Look back ~4500 blocks (roughly 30 minutes at 400ms blocks)
    const lookbackBlocks = 4500n;
    const fromBlock = currentBlock > lookbackBlocks ? currentBlock - lookbackBlocks : 0n;

    // Collect a few snapshots across the range for tx/gas averages
    const snapshots: BlockSnapshot[] = [currentSnapshot];
    const samplePoints = [fromBlock, fromBlock + lookbackBlocks / 4n, fromBlock + lookbackBlocks / 2n, fromBlock + (lookbackBlocks * 3n) / 4n];
    for (const bn of samplePoints) {
      try {
        const block = await publicClient.getBlock({ blockNumber: bn });
        snapshots.push({
          blockNumber: block.number,
          timestamp: Number(block.timestamp),
          transactionCount: block.transactions.length,
          gasUsed: block.gasUsed,
          gasLimit: block.gasLimit
        });
      } catch {
        // Skip if block not available
      }
    }

    // Single-pass scan + nad.fun in parallel
    const [scanResults, nadFunContext] = await Promise.all([
      scanBlocks(fromBlock, currentBlock),
      collectNadFunData().catch(() => null)
    ]);

    return aggregateSnapshots(snapshots, previousSummary, scanResults, nadFunContext);
  } catch (error) {
    console.error('[Chain] Failed to collect chain data:', error);
    const emptyScan: BlockScanResults = {
      largeTransfers: [], failedTxCount: 0, newContracts: 0,
      uniqueAddresses: new Set(), totalValueMoved: 0n,
      contractInteractions: 0, simpleTransfers: 0,
      maxSingleTxValue: 0n, txsScanned: 0,
      incomingNativeTransfers: []
    };
    return aggregateSnapshots([], previousSummary, emptyScan, null);
  }
}

export function formatChainDataForPrompt(summary: ChainDataSummary): string {
  const lines = [
    `Monad Chain Activity (last 30 minutes):`,
    `  Blocks observed: ${summary.blocksObserved}`,
    `  Avg transactions/block: ${summary.avgTransactionsPerBlock.toFixed(1)}`,
    `  Transaction trend: ${summary.txCountChange > 0 ? '+' : ''}${summary.txCountChange.toFixed(1)}% vs previous period`,
    `  Gas utilization: ${(summary.gasUtilization * 100).toFixed(1)}%`,
    `  Chain status: ${summary.isChainBusy ? 'BUSY - high activity' : summary.isChainQuiet ? 'QUIET - low activity' : 'NORMAL'}`,
  ];

  // New metrics
  if (summary.uniqueActiveAddresses > 0) {
    lines.push(`  Unique active addresses (sampled): ${summary.uniqueActiveAddresses}`);
  }
  if (summary.totalVolumeMonMoved > 0) {
    lines.push(`  Total MON volume moved: ${summary.totalVolumeMonMoved.toFixed(0)} MON`);
  }
  if (summary.avgTxValue > 0) {
    lines.push(`  Average tx value: ${summary.avgTxValue.toFixed(2)} MON`);
  }
  if (summary.maxSingleTxValue > 100) {
    lines.push(`  Largest single transfer: ${summary.maxSingleTxValue.toFixed(0)} MON`);
  }
  if (summary.contractInteractionRatio > 0) {
    const pct = (summary.contractInteractionRatio * 100).toFixed(0);
    lines.push(`  Contract calls vs simple transfers: ${pct}% are contract interactions`);
  }

  if (summary.largeTransfers.length > 0) {
    lines.push(`  Whale movements: ${summary.largeTransfers.length} large transfers detected`);
    // Only show the single largest, without exact from-address
    const largest = summary.largeTransfers.reduce((max, t) =>
      Number(t.value) > Number(max.value) ? t : max);
    lines.push(`    - largest: ~${(Number(largest.value) / 1e18).toFixed(0)} MON`);
  }

  if (summary.failedTxCount > 0) {
    lines.push(`  Failed transactions: ~${summary.failedTxCount}`);
  }

  if (summary.newContracts > 0) {
    lines.push(`  New contracts deployed: ${summary.newContracts}`);
  }

  // nad.fun section
  if (summary.nadFunContext) {
    const nf = summary.nadFunContext;
    lines.push('');
    lines.push('nad.fun Token Launchpad:');
    lines.push(`  New tokens launched: ${nf.creates}`);
    lines.push(`  Tokens graduated to DEX: ${nf.graduations}`);

    if (nf.recentGraduates.length > 0) {
      const names = nf.recentGraduates.map(g => g.name).join(', ');
      lines.push(`  Recent graduates: ${names}`);
    }

    if (nf.trendingTokens.length > 0) {
      lines.push('  Trending tokens (by bonding curve progress):');
      for (const t of nf.trendingTokens) {
        const pct = (t.progress / 100).toFixed(1);
        lines.push(`    - ${t.name} ($${t.symbol}): ${pct}%${t.isGraduated ? ' [GRADUATED]' : ''}`);
      }
    }

    // $EMO token - full DEX intelligence
    lines.push('');
    lines.push('$EMO Token (your token - emonad):');
    lines.push(`  Status: ${nf.emoToken.graduated ? 'GRADUATED to DEX' : `${(nf.emoToken.progress / 100).toFixed(1)}% bonding curve progress`}`);

    if (nf.emoToken.dex) {
      const dex = nf.emoToken.dex;
      lines.push(`  DEX Price: ${dex.priceMon.toFixed(8)} MON ($${dex.priceUsd.toFixed(6)} USD)`);
      if (dex.priceChangePercent !== 0) {
        lines.push(`  Price change (this cycle): ${dex.priceChangePercent >= 0 ? '+' : ''}${dex.priceChangePercent.toFixed(1)}%`);
      }
      lines.push(`  Trading activity (last 30 min): ${dex.swapCount} swaps`);
      if (dex.swapCount > 0) {
        lines.push(`    Buys: ${dex.buyCount} (${dex.volumeMonBuys.toFixed(1)} MON)`);
        lines.push(`    Sells: ${dex.sellCount} (${dex.volumeMonSells.toFixed(1)} MON)`);
        lines.push(`    Net flow: ${dex.netFlowMon >= 0 ? '+' : ''}${dex.netFlowMon.toFixed(1)} MON (${dex.netFlowMon >= 0 ? 'net buying' : 'net selling'})`);
      }
    }

    lines.push(`  Agent $EMO balance: ${nf.emoToken.balance || '0'}`);

    if (nf.emoToken.socialLinks) {
      const links = nf.emoToken.socialLinks;
      const parts: string[] = [];
      if (links.website) parts.push(`website: ${links.website}`);
      if (links.twitter) parts.push(`X: ${links.twitter}`);
      if (links.telegram) parts.push(`telegram: ${links.telegram}`);
      if (parts.length > 0) {
        lines.push(`  Social links: ${parts.join(' | ')}`);
      }
    }
  } else {
    // Fallback when nad.fun data unavailable
    if (summary.nadFunCreates > 0) {
      lines.push(`  nad.fun token launches: ${summary.nadFunCreates}`);
    }
    if (summary.nadFunGraduations > 0) {
      lines.push(`  nad.fun graduations: ${summary.nadFunGraduations}`);
    }
  }

  return lines.join('\n');
}
