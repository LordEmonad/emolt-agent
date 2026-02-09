import { publicClient, getWalletClient } from './client.js';
import type { EmotionState } from '../emotion/types.js';

const EMOODRING_ABI = [
  {
    type: 'function',
    name: 'emitMetadataUpdate',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable'
  }
] as const;

const TX_TIMEOUT_MS = 60_000;

// Track last emitted values to avoid redundant on-chain calls
let lastEmittedValues: string | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

export function getEmoodRingAddress(): `0x${string}` | null {
  const addr = process.env.EMOODRING_ADDRESS;
  if (!addr || addr === '' || addr === '0x') return null;
  return addr as `0x${string}`;
}

function emotionFingerprint(state: EmotionState): string {
  // Round to nearest 5% to avoid emitting for tiny fluctuations
  return Object.values(state.emotions)
    .map(v => Math.round(v * 20))
    .join(',');
}

export async function refreshEmoodRingMetadata(currentState?: EmotionState): Promise<void> {
  const address = getEmoodRingAddress();
  if (!address) return;

  // Skip if emotions haven't meaningfully changed
  if (currentState) {
    const fingerprint = emotionFingerprint(currentState);
    if (fingerprint === lastEmittedValues) {
      console.log('[EmoodRing] Emotions unchanged, skipping metadata refresh');
      return;
    }
    lastEmittedValues = fingerprint;
  }

  const walletClient = getWalletClient();

  const hash = await withTimeout(
    walletClient.writeContract({
      address,
      abi: EMOODRING_ABI,
      functionName: 'emitMetadataUpdate',
    }),
    TX_TIMEOUT_MS,
    'EmoodRing writeContract'
  );

  await withTimeout(
    publicClient.waitForTransactionReceipt({ hash }),
    TX_TIMEOUT_MS,
    'EmoodRing receipt'
  );
  console.log('[EmoodRing] Metadata refresh emitted');
}
