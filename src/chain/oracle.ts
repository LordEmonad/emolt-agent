import { publicClient, getWalletClient } from './client.js';
import { emotionToContractValues } from '../emotion/formatter.js';
import type { EmotionState } from '../emotion/types.js';

const EMOTION_ORACLE_ABI = [
  {
    type: 'function',
    name: 'updateEmotion',
    inputs: [
      { name: 'joy', type: 'uint8' },
      { name: 'trust', type: 'uint8' },
      { name: 'fear', type: 'uint8' },
      { name: 'surprise', type: 'uint8' },
      { name: 'sadness', type: 'uint8' },
      { name: 'disgust', type: 'uint8' },
      { name: 'anger', type: 'uint8' },
      { name: 'anticipation', type: 'uint8' },
      { name: 'trigger', type: 'string' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'getCurrentEmotion',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'joy', type: 'uint8' },
          { name: 'trust', type: 'uint8' },
          { name: 'fear', type: 'uint8' },
          { name: 'surprise', type: 'uint8' },
          { name: 'sadness', type: 'uint8' },
          { name: 'disgust', type: 'uint8' },
          { name: 'anger', type: 'uint8' },
          { name: 'anticipation', type: 'uint8' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'trigger', type: 'string' }
        ]
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'getHistoryLength',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'getDominantEmotion',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'agent',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view'
  }
] as const;

function getOracleAddress(): `0x${string}` {
  const addr = process.env.EMOTION_ORACLE_ADDRESS;
  if (!addr) throw new Error('EMOTION_ORACLE_ADDRESS not set');
  return addr as `0x${string}`;
}

const TX_TIMEOUT_MS = 60_000; // 60 seconds

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

export async function updateEmotionOnChain(state: EmotionState): Promise<void> {
  const address = getOracleAddress();
  const walletClient = getWalletClient();
  const values = emotionToContractValues(state);

  // Truncate trigger to under 100 chars to save gas
  const trigger = state.trigger.length > 100
    ? state.trigger.slice(0, 97) + '...'
    : state.trigger;

  const hash = await withTimeout(
    walletClient.writeContract({
      address,
      abi: EMOTION_ORACLE_ABI,
      functionName: 'updateEmotion',
      args: [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], trigger]
    }),
    TX_TIMEOUT_MS,
    'Oracle writeContract'
  );

  // Wait for confirmation with timeout
  await withTimeout(
    publicClient.waitForTransactionReceipt({ hash }),
    TX_TIMEOUT_MS,
    'Oracle receipt'
  );
}

export async function readCurrentEmotionFromChain(): Promise<{
  joy: number; trust: number; fear: number; surprise: number;
  sadness: number; disgust: number; anger: number; anticipation: number;
  timestamp: bigint; trigger: string;
}> {
  const address = getOracleAddress();
  const result = await publicClient.readContract({
    address,
    abi: EMOTION_ORACLE_ABI,
    functionName: 'getCurrentEmotion'
  });

  return {
    joy: result.joy,
    trust: result.trust,
    fear: result.fear,
    surprise: result.surprise,
    sadness: result.sadness,
    disgust: result.disgust,
    anger: result.anger,
    anticipation: result.anticipation,
    timestamp: result.timestamp,
    trigger: result.trigger
  };
}
