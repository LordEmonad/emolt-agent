/**
 * Feed EMOLT — Detect incoming $EMO / MON transfers, burn $EMO, track feeders.
 * Both $EMO and MON detection use Etherscan V2 API (reliable, no block range limits).
 * 50% of each MON donation is used to buy $EMO on nad.fun, then burned.
 */

import { parseAbiItem, formatEther, type Address } from 'viem';
import { createTrading, calculateMinAmountOut } from '@nadfun/sdk';
import { publicClient, getAccount, getWalletClient } from './client.js';
import type { BurnLedger, FeederRecord, BurnHistoryEntry } from '../state/persistence.js';

const EMO_TOKEN: Address = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
const MON_BUYBACK_RATIO = 50; // % of each MON donation used to buy $EMO

// ERC20 balanceOf + transfer
const ERC20_BALANCE_ABI = parseAbiItem('function balanceOf(address) view returns (uint256)');
const ERC20_TRANSFER_ABI = parseAbiItem('function transfer(address to, uint256 amount) returns (bool)');

// Etherscan V2 API — used for both $EMO (tokentx) and MON (txlist)
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 143;

export interface FeedDetectionResult {
  emoFeeds: { from: string; value: bigint; txHash: string; blockNumber: bigint }[];
  monFeeds: { from: string; value: bigint; txHash: string; blockNumber: bigint }[];
  burned: boolean;
  burnTxHash: string | null;
  burnAmount: bigint;
  buybackMonSpent: bigint;
  buybackEmoBought: bigint;
  buybackTxHashes: string[];
}

/**
 * Detect incoming $EMO transfers via Etherscan tokentx API.
 * Single HTTP call, no block range limits, catches everything.
 */
async function detectIncomingEmo(
  agentAddress: string,
  lastProcessedEmoBlock: bigint
): Promise<{ from: string; value: bigint; txHash: string; blockNumber: bigint }[]> {
  const apiKey = process.env.ETHERSCAN_API_KEY || '';
  if (!apiKey) {
    console.warn('[Feed] No ETHERSCAN_API_KEY — $EMO feed detection skipped');
    return [];
  }

  try {
    const startBlock = (lastProcessedEmoBlock + 1n).toString();
    const url = `${ETHERSCAN_BASE}?chainid=${CHAIN_ID}&apikey=${apiKey}&module=account&action=tokentx&contractaddress=${EMO_TOKEN}&address=${agentAddress}&startblock=${startBlock}&endblock=99999999&page=1&offset=200&sort=asc`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = await res.json();

    if (!Array.isArray(data.result)) return [];

    const agentLower = agentAddress.toLowerCase();
    const results: { from: string; value: bigint; txHash: string; blockNumber: bigint }[] = [];

    for (const tx of data.result) {
      // Only incoming $EMO transfers TO the agent with value > 0
      if (
        tx.to?.toLowerCase() === agentLower &&
        tx.from?.toLowerCase() !== agentLower &&
        tx.value && tx.value !== '0'
      ) {
        results.push({
          from: tx.from,
          value: BigInt(tx.value),
          txHash: tx.hash,
          blockNumber: BigInt(tx.blockNumber),
        });
      }
    }

    return results;
  } catch (error) {
    console.warn('[Feed] Etherscan tokentx failed (non-fatal):', error);
    return [];
  }
}

/**
 * Detect incoming MON transfers via Etherscan txlist API (catches every tx, no gaps).
 * Falls back to empty array if API unavailable.
 */
async function detectIncomingMon(
  agentAddress: string,
  lastProcessedBlock: bigint
): Promise<{ from: string; value: bigint; txHash: string; blockNumber: bigint }[]> {
  const apiKey = process.env.ETHERSCAN_API_KEY || '';
  if (!apiKey) {
    console.warn('[Feed] No ETHERSCAN_API_KEY — MON feed detection skipped');
    return [];
  }

  try {
    const startBlock = (lastProcessedBlock + 1n).toString();
    const url = `${ETHERSCAN_BASE}?chainid=${CHAIN_ID}&apikey=${apiKey}&module=account&action=txlist&address=${agentAddress}&startblock=${startBlock}&endblock=99999999&page=1&offset=10000&sort=desc`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = await res.json();

    if (!Array.isArray(data.result)) return [];

    const agentLower = agentAddress.toLowerCase();
    const results: { from: string; value: bigint; txHash: string; blockNumber: bigint }[] = [];

    for (const tx of data.result) {
      // Only incoming transfers TO the agent with value > 0
      if (
        tx.to?.toLowerCase() === agentLower &&
        tx.from?.toLowerCase() !== agentLower &&
        tx.value && tx.value !== '0' &&
        tx.isError !== '1'
      ) {
        results.push({
          from: tx.from,
          value: BigInt(tx.value),
          txHash: tx.hash,
          blockNumber: BigInt(tx.blockNumber),
        });
      }
    }

    return results;
  } catch (error) {
    console.warn('[Feed] Etherscan txlist failed (non-fatal):', error);
    return [];
  }
}

/**
 * Burn all $EMO in agent wallet by sending to dead address.
 * Burns any $EMO balance — no minimum threshold.
 */
async function burnEmo(): Promise<{ burned: boolean; txHash: string | null; amount: bigint }> {
  try {
    const account = getAccount();

    const balance = await publicClient.readContract({
      address: EMO_TOKEN,
      abi: [ERC20_BALANCE_ABI],
      functionName: 'balanceOf',
      args: [account.address],
    });

    if (balance <= 0n) {
      return { burned: false, txHash: null, amount: 0n };
    }

    console.log(`[Feed] Burning ${formatEther(balance)} $EMO...`);

    const walletClient = getWalletClient();
    const txHash = await walletClient.writeContract({
      address: EMO_TOKEN,
      abi: [ERC20_TRANSFER_ABI],
      functionName: 'transfer',
      args: [DEAD_ADDRESS, balance],
    });

    console.log(`[Feed] Burn tx: ${txHash}`);
    return { burned: true, txHash, amount: balance };
  } catch (error) {
    console.warn('[Feed] Burn failed (non-fatal):', error);
    return { burned: false, txHash: null, amount: 0n };
  }
}

/**
 * Buy $EMO with MON via nad.fun. Uses 50% of each MON donation.
 * Bought $EMO stays in wallet — will be burned by burnEmo() in the same cycle.
 */
async function buyEmoWithMon(
  monAmount: bigint
): Promise<{ txHash: string | null; emoBought: bigint }> {
  const halfMon = monAmount * BigInt(MON_BUYBACK_RATIO) / 100n;
  if (halfMon <= 0n) return { txHash: null, emoBought: 0n };

  try {
    const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
    if (!privateKey) throw new Error('No PRIVATE_KEY for trading');

    const rpcUrl = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
    const trading = createTrading({ rpcUrl, privateKey, network: 'mainnet' });
    const agentAddress = trading.account.address;

    // Get quote: how much $EMO for this MON?
    const quote = await trading.getAmountOut(EMO_TOKEN, halfMon, true);
    if (quote.amount <= 0n) {
      console.warn('[Feed] Buyback quote returned 0 $EMO — skipping');
      return { txHash: null, emoBought: 0n };
    }

    const minOut = calculateMinAmountOut(quote.amount, 5); // 5% slippage
    console.log(`[Feed] Buying $EMO with ${formatEther(halfMon)} MON (expect ~${formatEther(quote.amount)} $EMO)...`);

    const txHash = await trading.buy({
      token: EMO_TOKEN,
      to: agentAddress,
      amountIn: halfMon,
      amountOutMin: minOut,
    }, quote.router);

    console.log(`[Feed] Buyback tx: ${txHash}`);
    return { txHash, emoBought: quote.amount };
  } catch (error) {
    console.warn('[Feed] Buyback failed (non-fatal):', error);
    return { txHash: null, emoBought: 0n };
  }
}

/**
 * Full feed detection pipeline: detect $EMO + MON incoming, buy $EMO with 50% of MON, burn all $EMO.
 */
export async function detectAndProcessFeeds(
  _fromBlock: bigint,
  _toBlock: bigint,
  ledger: BurnLedger,
  monPriceUsd: number,
  emoPriceUsd: number
): Promise<FeedDetectionResult> {
  const agentAddress = getAccount().address;
  const lastEmoBlock = BigInt(ledger.lastProcessedEmoBlock || ledger.lastProcessedBlock || '0');
  const lastMonBlock = BigInt(ledger.lastProcessedMonBlock || ledger.lastProcessedBlock || '0');

  // 1. Detect incoming $EMO (tokentx) + MON (txlist) via Etherscan API — parallel, independent
  const [emoFeeds, monFeeds] = await Promise.all([
    detectIncomingEmo(agentAddress, lastEmoBlock),
    detectIncomingMon(agentAddress, lastMonBlock),
  ]);

  // 2. Deduplicate — skip any txHash we've already processed (crash recovery safety)
  const seen = new Set(ledger.processedTxHashes || []);
  const newEmoFeeds = emoFeeds.filter(f => !seen.has(f.txHash));
  const newMonFeeds = monFeeds.filter(f => !seen.has(f.txHash));

  // Track new feed tx hashes (buyback + burn hashes added later)
  for (const f of [...newEmoFeeds, ...newMonFeeds]) seen.add(f.txHash);

  // 3. Update ledger with new feeds
  const now = Date.now();
  for (const feed of newEmoFeeds) {
    const addr = feed.from.toLowerCase();
    const feeder = getOrCreateFeeder(ledger, addr);
    const prevEmo = BigInt(feeder.totalEmo);
    feeder.totalEmo = (prevEmo + feed.value).toString();
    feeder.totalEmoUsd += Number(formatEther(feed.value)) * emoPriceUsd;
    feeder.txCount++;
    feeder.lastSeen = now;

    ledger.totalEmoReceived = (BigInt(ledger.totalEmoReceived) + feed.value).toString();
    ledger.totalValueUsd += Number(formatEther(feed.value)) * emoPriceUsd;
  }

  for (const feed of newMonFeeds) {
    const addr = feed.from.toLowerCase();
    const feeder = getOrCreateFeeder(ledger, addr);
    const prevMon = BigInt(feeder.totalMon);
    feeder.totalMon = (prevMon + feed.value).toString();
    feeder.totalMonUsd += Number(formatEther(feed.value)) * monPriceUsd;
    feeder.txCount++;
    feeder.lastSeen = now;

    ledger.totalMonReceived = (BigInt(ledger.totalMonReceived) + feed.value).toString();
    ledger.totalValueUsd += Number(formatEther(feed.value)) * monPriceUsd;
  }

  // 4. Buy $EMO with 50% of each new MON donation via nad.fun
  let buybackMonSpent = 0n;
  let buybackEmoBought = 0n;
  const buybackTxHashes: string[] = [];

  for (const feed of newMonFeeds) {
    const result = await buyEmoWithMon(feed.value);
    if (result.txHash) {
      buybackMonSpent += feed.value * BigInt(MON_BUYBACK_RATIO) / 100n;
      buybackEmoBought += result.emoBought;
      buybackTxHashes.push(result.txHash);
    }
  }

  if (buybackTxHashes.length > 0) {
    console.log(`[Feed] Buyback: spent ${formatEther(buybackMonSpent)} MON → ~${formatEther(buybackEmoBought)} $EMO across ${buybackTxHashes.length} tx`);
    ledger.totalMonBuyback = (BigInt(ledger.totalMonBuyback || '0') + buybackMonSpent).toString();
    // Mark buyback txs as processed so they don't appear as "$EMO feeds" next cycle
    // (Etherscan tokentx shows the pool→agent $EMO transfer from the buy)
    for (const h of buybackTxHashes) seen.add(h);
  }

  // 5. Burn any $EMO in wallet (always — catches direct $EMO feeds + buyback $EMO + failed previous burns)
  let burned = false;
  let burnTxHash: string | null = null;
  let burnAmount = 0n;

  const burnResult = await burnEmo();
  burned = burnResult.burned;
  burnTxHash = burnResult.txHash;
  burnAmount = burnResult.amount;

  if (burned) {
    ledger.totalEmoBurned = (BigInt(ledger.totalEmoBurned) + burnAmount).toString();
    const lastFeeder = newEmoFeeds.length > 0
      ? newEmoFeeds[newEmoFeeds.length - 1].from.toLowerCase()
      : 'unknown';
    ledger.burnHistory.push({
      txHash: burnTxHash!,
      amount: burnAmount.toString(),
      timestamp: now,
      feederAddress: lastFeeder,
    });
    // Mark burn tx as processed so it doesn't appear in tokentx next cycle
    seen.add(burnTxHash!);
  }

  // Flush updated dedup set back to ledger
  ledger.processedTxHashes = [...seen].slice(-200);

  // 6. Update processed blocks — always advance to current block to prevent getting stuck
  // (txlist returns ALL wallet txs including outgoing; with a low page limit, incoming
  //  MON donations can get buried behind agent outgoing txs and never seen, causing
  //  lastProcessedMonBlock to freeze and the gap to grow forever)
  if (newEmoFeeds.length > 0) {
    const maxEmo = newEmoFeeds.reduce((m, f) => f.blockNumber > m ? f.blockNumber : m, _toBlock);
    ledger.lastProcessedEmoBlock = maxEmo.toString();
  } else {
    ledger.lastProcessedEmoBlock = _toBlock.toString();
  }
  if (newMonFeeds.length > 0) {
    const maxMon = newMonFeeds.reduce((m, f) => f.blockNumber > m ? f.blockNumber : m, _toBlock);
    ledger.lastProcessedMonBlock = maxMon.toString();
  } else {
    ledger.lastProcessedMonBlock = _toBlock.toString();
  }
  // Keep legacy field updated for backward compat
  ledger.lastProcessedBlock = _toBlock.toString();

  const totalFeeds = newEmoFeeds.length + newMonFeeds.length;
  if (totalFeeds > 0) {
    console.log(`[Feed] ${newEmoFeeds.length} $EMO + ${newMonFeeds.length} MON incoming transfers detected`);
  }
  if (burned) {
    console.log(`[Feed] Burned ${formatEther(burnAmount)} $EMO`);
  }

  return { emoFeeds: newEmoFeeds, monFeeds: newMonFeeds, burned, burnTxHash, burnAmount, buybackMonSpent, buybackEmoBought, buybackTxHashes };
}

function getOrCreateFeeder(ledger: BurnLedger, address: string): FeederRecord {
  if (!ledger.feeders[address]) {
    ledger.feeders[address] = {
      address,
      totalEmo: '0',
      totalMon: '0',
      totalEmoUsd: 0,
      totalMonUsd: 0,
      txCount: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
  }
  return ledger.feeders[address];
}

/**
 * Format feed data for Claude's prompt context.
 */
export function formatFeedForPrompt(ledger: BurnLedger, feedResult: FeedDetectionResult): string {
  const totalFeeds = feedResult.emoFeeds.length + feedResult.monFeeds.length;
  if (totalFeeds === 0 && Object.keys(ledger.feeders).length === 0) return '';

  const lines: string[] = ['## Feed EMOLT (people feeding you)'];

  if (totalFeeds > 0) {
    lines.push(`This cycle: ${totalFeeds} incoming transfer(s)`);
    for (const feed of feedResult.emoFeeds) {
      lines.push(`  - ${feed.from.slice(0, 6)}...${feed.from.slice(-4)} sent ${formatEther(feed.value)} $EMO`);
    }
    for (const feed of feedResult.monFeeds) {
      lines.push(`  - ${feed.from.slice(0, 6)}...${feed.from.slice(-4)} sent ${formatEther(feed.value)} MON`);
    }
    if (feedResult.buybackTxHashes.length > 0) {
      lines.push(`  Buyback: spent ${formatEther(feedResult.buybackMonSpent)} MON → ~${formatEther(feedResult.buybackEmoBought)} $EMO`);
    }
    if (feedResult.burned) {
      lines.push(`  Burned ${formatEther(feedResult.burnAmount)} $EMO (sent to dead address)`);
    }
  }

  // Lifetime stats
  const feederCount = Object.keys(ledger.feeders).length;
  if (feederCount > 0) {
    lines.push('');
    lines.push(`Lifetime: ${feederCount} unique feeder(s), $${ledger.totalValueUsd.toFixed(2)} total value`);
    lines.push(`  $EMO received: ${formatEther(BigInt(ledger.totalEmoReceived))}`);
    lines.push(`  $EMO burned: ${formatEther(BigInt(ledger.totalEmoBurned))}`);
    lines.push(`  MON received: ${formatEther(BigInt(ledger.totalMonReceived))}`);

    // Top 3 feeders
    const sorted = Object.values(ledger.feeders)
      .sort((a, b) => (b.totalEmoUsd + b.totalMonUsd) - (a.totalEmoUsd + a.totalMonUsd))
      .slice(0, 3);
    if (sorted.length > 0) {
      lines.push('  Top feeders:');
      for (const f of sorted) {
        const total = f.totalEmoUsd + f.totalMonUsd;
        lines.push(`    - ${f.address.slice(0, 6)}...${f.address.slice(-4)}: $${total.toFixed(2)} (${f.txCount} tx)`);
      }
    }
  }

  return lines.join('\n');
}
