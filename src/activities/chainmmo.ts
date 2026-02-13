import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { registerActivity } from './registry.js';
import { loadEmotionState, atomicWriteFileSync, STATE_DIR, ensureStateDir } from '../state/persistence.js';
import { monad, publicClient } from '../chain/client.js';
import type { DispatchPlan, DispatchLogger, DispatchResult } from './types.js';

// --- Constants ---

const CHAINMMO_API = 'https://chainmmo.com';
const STATE_FILE = join(STATE_DIR, 'chainmmo-state.json');
const TX_TIMEOUT_MS = 30_000;
const BLOCK_WAIT_MS = 2_500;
const MIN_REVEAL_BLOCKS = 2;
const MAX_REVEAL_BLOCKS = 256;
const ACTION_DELAY_MS = 3_000;
const CONTRACT_CACHE_TTL_MS = 600_000; // 10 min

// Game enums
const Race = { Human: 0, Dwarf: 1, Elf: 2 } as const;
const Class_ = { Warrior: 0, Paladin: 1, Mage: 2 } as const;
const Difficulty = { Easy: 0, Normal: 1, Hard: 2, Extreme: 3, Challenger: 4 } as const;
const Variance = { Stable: 0, Neutral: 1, Swingy: 2 } as const;
const ActionType = { LOOTBOX_OPEN: 1, DUNGEON_RUN: 2 } as const;
const PotionChoice = { NONE: 0, HP_REGEN: 1, MANA_REGEN: 2, POWER: 3 } as const;
const AbilityChoice = { NONE: 0, ARCANE_FOCUS: 1, BERSERK: 2, DIVINE_SHIELD: 3 } as const;

// --- ABI Fragments (inline as const — same pattern as chain/oracle.ts) ---
// Signatures from game docs. May need minor tweaks if actual contract differs.

const GAME_WORLD_ABI = [
  {
    type: 'function',
    name: 'createCharacter',
    inputs: [
      { name: 'race', type: 'uint8' },
      { name: 'classType', type: 'uint8' },
      { name: 'name', type: 'string' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimFreeLootbox',
    inputs: [{ name: 'characterId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'commitActionWithVariance',
    inputs: [
      { name: 'characterId', type: 'uint256' },
      { name: 'actionType', type: 'uint8' },
      { name: 'hash', type: 'bytes32' },
      { name: 'nonce', type: 'uint64' },
      { name: 'varianceMode', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revealOpenLootboxesMax',
    inputs: [
      { name: 'commitId', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'tier', type: 'uint32' },
      { name: 'maxAmount', type: 'uint16' },
      { name: 'varianceMode', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revealStartDungeon',
    inputs: [
      { name: 'commitId', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'difficulty', type: 'uint8' },
      { name: 'dungeonLevel', type: 'uint32' },
      { name: 'varianceMode', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'resolveRooms',
    inputs: [
      { name: 'characterId', type: 'uint256' },
      { name: 'potionChoices', type: 'uint8[]' },
      { name: 'abilityChoices', type: 'uint8[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'equipItems',
    inputs: [
      { name: 'characterId', type: 'uint256' },
      { name: 'itemIds', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getRunState',
    inputs: [{ name: 'characterId', type: 'uint256' }],
    outputs: [
      { name: 'active', type: 'bool' },
      { name: 'roomIndex', type: 'uint8' },
      { name: 'hp', type: 'uint16' },
      { name: 'mana', type: 'uint16' },
      { name: 'potions', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getProgressionSnapshot',
    inputs: [{ name: 'characterId', type: 'uint256' }],
    outputs: [
      { name: 'best', type: 'uint32' },
      { name: 'target', type: 'uint32' },
      { name: 'progress', type: 'uint32' },
      { name: 'pressure', type: 'uint16' },
      { name: 'sinks', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nextCommitId',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hashLootboxOpen',
    inputs: [
      { name: 'secret', type: 'bytes32' },
      { name: 'actor', type: 'address' },
      { name: 'characterId', type: 'uint256' },
      { name: 'nonce', type: 'uint64' },
      { name: 'tier', type: 'uint32' },
      { name: 'amount', type: 'uint16' },
      { name: 'varianceMode', type: 'uint8' },
      { name: 'maxMode', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hashDungeonRun',
    inputs: [
      { name: 'secret', type: 'bytes32' },
      { name: 'actor', type: 'address' },
      { name: 'characterId', type: 'uint256' },
      { name: 'nonce', type: 'uint64' },
      { name: 'difficulty', type: 'uint8' },
      { name: 'dungeonLevel', type: 'uint32' },
      { name: 'varianceMode', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
] as const;

const ITEMS_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const MMO_TOKEN_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

// --- Types ---

interface ContractAddresses {
  gameWorld: `0x${string}`;
  items: `0x${string}`;
  mmoToken: `0x${string}`;
  feeVault: `0x${string}`;
  tradeEscrow: `0x${string}`;
  rfqMarket: `0x${string}`;
}

interface ChainMMOState {
  characterId: number | null;
  characterName: string;
  race: number;
  class_: number;
  currentLevel: number;
  bestLevelCleared: number;
  gearSummary: Record<number, number>; // slot → tokenId
  mmoTokenBalance: string;
  contractAddresses: ContractAddresses | null;
  contractsFetchedAt: number;
  lifetime: {
    sessions: number;
    totalRuns: number;
    totalClears: number;
    totalDeaths: number;
    totalItemsFound: number;
    totalTrades: number;
    totalLootboxesOpened: number;
    roomsCleared: number;
  };
  pendingCommit: {
    type: 'lootbox' | 'dungeon';
    secret: string;
    commitId: string; // bigint as string
    commitBlockNumber: number;
    commitTxHash: string;
    difficulty?: number;
    dungeonLevel?: number;
    variance?: number;
    tier?: number;
  } | null;
}

interface EmotionProfile {
  aggression: number;    // anger + anticipation → higher difficulty, Swingy
  caution: number;       // fear + sadness → lower difficulty, Stable
  optimism: number;      // joy + trust → willing to trade
  restlessness: number;  // surprise + anger → try Challenger
  tidiness: number;      // disgust → sell junk
  persistence: number;   // trust + anticipation → grind longer
}

type ChainMMOMode = 'adventure' | 'dungeon' | 'loot' | 'trade';

// --- State Persistence ---

function createDefaultState(): ChainMMOState {
  return {
    characterId: null,
    characterName: '',
    race: 0,
    class_: 0,
    currentLevel: 1,
    bestLevelCleared: 0,
    gearSummary: {},
    mmoTokenBalance: '0',
    contractAddresses: null,
    contractsFetchedAt: 0,
    lifetime: {
      sessions: 0, totalRuns: 0, totalClears: 0, totalDeaths: 0,
      totalItemsFound: 0, totalTrades: 0, totalLootboxesOpened: 0, roomsCleared: 0,
    },
    pendingCommit: null,
  };
}

function loadChainMMOState(): ChainMMOState {
  try {
    const data = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return createDefaultState();
  }
}

function saveChainMMOState(state: ChainMMOState): void {
  ensureStateDir();
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateSecret(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
}

async function mmoGet(path: string): Promise<any> {
  const res = await fetch(`${CHAINMMO_API}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchContractAddresses(state: ChainMMOState, log: DispatchLogger): Promise<ContractAddresses> {
  if (state.contractAddresses && (Date.now() - state.contractsFetchedAt) < CONTRACT_CACHE_TTL_MS) {
    log('thought', 'using cached contract addresses');
    return state.contractAddresses;
  }

  log('step', 'fetching contract addresses from /meta/contracts...');
  const data = await mmoGet('/meta/contracts');
  const c = data.contracts || data;

  const addresses: ContractAddresses = {
    gameWorld: (c.GameWorld || c.gameWorld || c.game_world) as `0x${string}`,
    items: (c.Items || c.items) as `0x${string}`,
    mmoToken: (c.MMOToken || c.mmoToken || c.mmo_token) as `0x${string}`,
    feeVault: (c.FeeVault || c.feeVault || c.fee_vault) as `0x${string}`,
    tradeEscrow: (c.TradeEscrow || c.tradeEscrow || c.trade_escrow) as `0x${string}`,
    rfqMarket: (c.RFQMarket || c.rfqMarket || c.rfq_market) as `0x${string}`,
  };

  if (!addresses.gameWorld) {
    throw new Error(`GameWorld not found in /meta/contracts: ${JSON.stringify(data).slice(0, 300)}`);
  }

  state.contractAddresses = addresses;
  state.contractsFetchedAt = Date.now();
  saveChainMMOState(state);

  log('step', `contracts loaded: GameWorld=${addresses.gameWorld.slice(0, 10)}...`);
  return addresses;
}

async function fetchValidActions(characterId: number, log: DispatchLogger): Promise<any> {
  try {
    const data = await mmoGet(`/agent/valid-actions/${characterId}`);
    log('thought', `valid actions: ${JSON.stringify(data).slice(0, 500)}`);
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `valid-actions check failed (non-fatal): ${msg}`);
    return null;
  }
}

async function fetchCharacterState(characterId: number, log: DispatchLogger): Promise<any> {
  try {
    const data = await mmoGet(`/agent/state/${characterId}`);
    log('thought', `character state: ${JSON.stringify(data).slice(0, 600)}`);
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `character state fetch failed: ${msg}`);
    return null;
  }
}

// --- Wallet Client (BURNER_PRIVATE_KEY ONLY — no fallback) ---

function getMMOWalletClient() {
  const pk = process.env.BURNER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) {
    throw new Error('BURNER_PRIVATE_KEY required for ChainMMO — will not use main wallet for third-party games');
  }
  const account = privateKeyToAccount(pk);
  return {
    walletClient: createWalletClient({
      account,
      chain: monad,
      transport: http(process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz'),
    }),
    account,
  };
}

// --- Emotion → Gameplay Profile ---

function emotionToProfile(): EmotionProfile {
  const state = loadEmotionState();
  const e = state.emotions;
  return {
    aggression: Math.min(1, (e.anger ?? 0) * 1.2 + (e.anticipation ?? 0) * 0.5),
    caution: Math.min(1, (e.fear ?? 0) * 0.9 + (e.sadness ?? 0) * 0.5 + (e.trust ?? 0) * 0.3),
    optimism: Math.min(1, (e.joy ?? 0) * 0.8 + (e.trust ?? 0) * 0.5 + (e.anticipation ?? 0) * 0.3),
    restlessness: Math.min(1, (e.surprise ?? 0) * 0.8 + (e.anger ?? 0) * 0.3 + (e.anticipation ?? 0) * 0.4),
    tidiness: Math.min(1, (e.disgust ?? 0) * 0.9 + (e.trust ?? 0) * 0.3),
    persistence: Math.min(1, (e.trust ?? 0) * 0.7 + (e.sadness ?? 0) * 0.4 + (e.anticipation ?? 0) * 0.4),
  };
}

function describeEmotion(): string {
  const state = loadEmotionState();
  const top = Object.entries(state.emotions)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 3)
    .map(([name, val]) => `${name} (${(val as number).toFixed(2)})`)
    .join(', ');
  return `dominant: ${state.dominantLabel} | top: ${top}`;
}

function pickDifficulty(profile: EmotionProfile, currentLevel: number): number {
  if (profile.restlessness > 0.7 && currentLevel >= 5) return Difficulty.Challenger;
  if (profile.aggression > 0.6) return Difficulty.Hard;
  if (profile.caution > 0.6) return Difficulty.Easy;
  if (currentLevel < 3) return Difficulty.Easy;
  return Difficulty.Normal;
}

function pickVariance(profile: EmotionProfile): number {
  if (profile.aggression > 0.6) return Variance.Swingy;
  if (profile.caution > 0.6) return Variance.Stable;
  return Variance.Neutral;
}

function pickRace(profile: EmotionProfile): number {
  if (profile.caution > 0.6) return Race.Dwarf;
  if (profile.restlessness > 0.6) return Race.Elf;
  return Race.Human;
}

function pickClass(profile: EmotionProfile): number {
  if (profile.aggression > 0.6) return Class_.Warrior;
  if (profile.caution > 0.6) return Class_.Paladin;
  return Class_.Mage;
}

function pickPotionChoice(profile: EmotionProfile): number {
  if (profile.aggression > 0.6) return PotionChoice.POWER;
  if (profile.caution > 0.6) return PotionChoice.HP_REGEN;
  return PotionChoice.MANA_REGEN;
}

function pickAbilityChoice(profile: EmotionProfile): number {
  if (profile.aggression > 0.6) return AbilityChoice.BERSERK;
  if (profile.caution > 0.6) return AbilityChoice.DIVINE_SHIELD;
  return AbilityChoice.ARCANE_FOCUS;
}

// --- Commit-Reveal Core ---

async function waitForBlocks(
  startBlock: bigint,
  blocksNeeded: number,
  signal: AbortSignal,
  log: DispatchLogger,
): Promise<void> {
  const targetBlock = startBlock + BigInt(blocksNeeded);
  log('step', `waiting for block ${targetBlock} (current: ${startBlock}, need +${blocksNeeded})...`);

  while (!signal.aborted) {
    const currentBlock = await publicClient.getBlockNumber();
    if (currentBlock >= targetBlock) {
      log('step', `block ${currentBlock} reached target ${targetBlock}`);
      return;
    }
    await sleep(BLOCK_WAIT_MS);
  }
  throw new Error('aborted while waiting for blocks');
}

async function commitRevealLootbox(
  characterId: bigint,
  contracts: ContractAddresses,
  walletClient: any,
  account: any,
  state: ChainMMOState,
  varianceMode: number,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<{ success: boolean; txHash?: string }> {
  log('step', 'commit-reveal: opening lootbox...');

  const secret = generateSecret();
  const nonce = await publicClient.readContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'nextCommitId',
  });
  log('thought', `nonce: ${nonce}`);

  // Compute hash via view function
  const hash = await publicClient.readContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'hashLootboxOpen',
    args: [secret, account.address, characterId, nonce, 0, 5, varianceMode, true],
  });
  log('thought', `hash: ${String(hash).slice(0, 18)}...`);

  // Submit commit
  const commitTxHash = await walletClient.writeContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'commitActionWithVariance',
    args: [characterId, ActionType.LOOTBOX_OPEN, hash, nonce, varianceMode],
  });
  log('action', `commit tx: ${commitTxHash}`);

  const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash, timeout: TX_TIMEOUT_MS });
  if (commitReceipt.status !== 'success') throw new Error(`commit tx reverted: ${commitTxHash}`);
  log('step', `commit confirmed at block ${commitReceipt.blockNumber}`);

  // Save pending commit for crash recovery
  state.pendingCommit = {
    type: 'lootbox',
    secret,
    commitId: String(nonce),
    commitBlockNumber: Number(commitReceipt.blockNumber),
    commitTxHash,
    variance: varianceMode,
    tier: 0,
  };
  saveChainMMOState(state);

  // Wait for blocks
  await waitForBlocks(commitReceipt.blockNumber, MIN_REVEAL_BLOCKS, signal, log);

  // Submit reveal
  const revealTxHash = await walletClient.writeContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'revealOpenLootboxesMax',
    args: [BigInt(state.pendingCommit.commitId), secret, 0, 5, varianceMode],
  });
  log('action', `reveal tx: ${revealTxHash}`);

  const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealTxHash, timeout: TX_TIMEOUT_MS });
  if (revealReceipt.status !== 'success') throw new Error(`reveal tx reverted: ${revealTxHash}`);

  // Clear pending commit
  state.pendingCommit = null;
  saveChainMMOState(state);

  log('result', 'lootbox opened successfully!');
  return { success: true, txHash: revealTxHash };
}

async function commitRevealDungeon(
  characterId: bigint,
  contracts: ContractAddresses,
  walletClient: any,
  account: any,
  state: ChainMMOState,
  difficulty: number,
  dungeonLevel: number,
  varianceMode: number,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<{ success: boolean; txHash?: string }> {
  log('step', `commit-reveal: starting dungeon (level=${dungeonLevel}, diff=${difficulty}, var=${varianceMode})...`);

  const secret = generateSecret();
  const nonce = await publicClient.readContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'nextCommitId',
  });
  log('thought', `nonce: ${nonce}`);

  // Compute hash via view function
  const hash = await publicClient.readContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'hashDungeonRun',
    args: [secret, account.address, characterId, nonce, difficulty, dungeonLevel, varianceMode],
  });
  log('thought', `hash: ${String(hash).slice(0, 18)}...`);

  // Submit commit
  const commitTxHash = await walletClient.writeContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'commitActionWithVariance',
    args: [characterId, ActionType.DUNGEON_RUN, hash, nonce, varianceMode],
  });
  log('action', `commit tx: ${commitTxHash}`);

  const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash, timeout: TX_TIMEOUT_MS });
  if (commitReceipt.status !== 'success') throw new Error(`commit tx reverted: ${commitTxHash}`);
  log('step', `commit confirmed at block ${commitReceipt.blockNumber}`);

  // Save pending commit for crash recovery
  state.pendingCommit = {
    type: 'dungeon',
    secret,
    commitId: String(nonce),
    commitBlockNumber: Number(commitReceipt.blockNumber),
    commitTxHash,
    difficulty,
    dungeonLevel,
    variance: varianceMode,
  };
  saveChainMMOState(state);

  // Wait for blocks
  await waitForBlocks(commitReceipt.blockNumber, MIN_REVEAL_BLOCKS, signal, log);

  // Submit reveal
  const revealTxHash = await walletClient.writeContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'revealStartDungeon',
    args: [BigInt(state.pendingCommit.commitId), secret, difficulty, dungeonLevel, varianceMode],
  });
  log('action', `reveal tx: ${revealTxHash}`);

  const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealTxHash, timeout: TX_TIMEOUT_MS });
  if (revealReceipt.status !== 'success') throw new Error(`reveal tx reverted: ${revealTxHash}`);

  // Clear pending commit
  state.pendingCommit = null;
  saveChainMMOState(state);

  log('result', 'dungeon started successfully!');
  return { success: true, txHash: revealTxHash };
}

async function recoverPendingCommit(
  state: ChainMMOState,
  contracts: ContractAddresses,
  walletClient: any,
  account: any,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<void> {
  const pending = state.pendingCommit;
  if (!pending) return;

  log('step', `recovering pending ${pending.type} commit from block ${pending.commitBlockNumber}...`);

  const currentBlock = await publicClient.getBlockNumber();
  const blocksSince = Number(currentBlock) - pending.commitBlockNumber;

  if (blocksSince > MAX_REVEAL_BLOCKS) {
    log('error', `pending commit expired (${blocksSince} blocks > ${MAX_REVEAL_BLOCKS}). clearing.`);
    state.pendingCommit = null;
    saveChainMMOState(state);
    return;
  }

  if (blocksSince < MIN_REVEAL_BLOCKS) {
    log('step', `waiting for reveal window (${blocksSince}/${MIN_REVEAL_BLOCKS} blocks)...`);
    await waitForBlocks(BigInt(pending.commitBlockNumber), MIN_REVEAL_BLOCKS, signal, log);
  }

  const secret = pending.secret as `0x${string}`;
  const commitId = BigInt(pending.commitId);

  try {
    if (pending.type === 'lootbox') {
      const txHash = await walletClient.writeContract({
        address: contracts.gameWorld,
        abi: GAME_WORLD_ABI,
        functionName: 'revealOpenLootboxesMax',
        args: [commitId, secret, pending.tier ?? 0, 5, pending.variance ?? 0],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
      log('result', `recovered lootbox reveal: ${receipt.status === 'success' ? 'success' : 'reverted'}`);
    } else {
      const txHash = await walletClient.writeContract({
        address: contracts.gameWorld,
        abi: GAME_WORLD_ABI,
        functionName: 'revealStartDungeon',
        args: [commitId, secret, pending.difficulty ?? 0, pending.dungeonLevel ?? 1, pending.variance ?? 0],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
      log('result', `recovered dungeon reveal: ${receipt.status === 'success' ? 'success' : 'reverted'}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `recovery reveal failed: ${msg}`);
  }

  state.pendingCommit = null;
  saveChainMMOState(state);
}

// --- Game Actions ---

async function createCharacter(
  profile: EmotionProfile,
  contracts: ContractAddresses,
  walletClient: any,
  account: any,
  state: ChainMMOState,
  log: DispatchLogger,
): Promise<number> {
  const race = pickRace(profile);
  const classType = pickClass(profile);
  const raceName = Object.entries(Race).find(([, v]) => v === race)?.[0] || 'Human';
  const className = Object.entries(Class_).find(([, v]) => v === classType)?.[0] || 'Mage';

  log('action', `creating character: EMOLT (${raceName} ${className})`);

  const txHash = await walletClient.writeContract({
    address: contracts.gameWorld,
    abi: GAME_WORLD_ABI,
    functionName: 'createCharacter',
    args: [race, classType, 'EMOLT'],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
  if (receipt.status !== 'success') throw new Error(`createCharacter tx reverted: ${txHash}`);

  log('step', 'character created. looking up ID...');

  // Fetch character list from API to get the ID
  await sleep(ACTION_DELAY_MS);
  let characterId: number | null = null;
  try {
    const chars = await mmoGet(`/agent/characters/${account.address}`);
    const charList = chars.characters || chars || [];
    if (Array.isArray(charList) && charList.length > 0) {
      const newest = charList[charList.length - 1];
      characterId = newest.id ?? newest.characterId ?? newest.tokenId ?? null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `character lookup after creation failed: ${msg}`);
  }

  if (characterId === null) {
    // Fallback: read from contract events or use a sequential ID
    log('thought', 'could not find character ID from API — using 1 as fallback');
    characterId = 1;
  }

  state.characterId = characterId;
  state.characterName = 'EMOLT';
  state.race = race;
  state.class_ = classType;
  state.currentLevel = 1;
  saveChainMMOState(state);

  log('result', `character #${characterId} created: EMOLT the ${raceName} ${className}`);
  return characterId;
}

async function claimFreeLootbox(
  characterId: bigint,
  contracts: ContractAddresses,
  walletClient: any,
  log: DispatchLogger,
): Promise<boolean> {
  try {
    log('action', 'claiming free lootbox...');
    const txHash = await walletClient.writeContract({
      address: contracts.gameWorld,
      abi: GAME_WORLD_ABI,
      functionName: 'claimFreeLootbox',
      args: [characterId],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
    if (receipt.status === 'success') {
      log('result', 'free lootbox claimed!');
      return true;
    }
    log('thought', 'claim tx reverted — may have already claimed');
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `claim lootbox failed (may already have claimed): ${msg}`);
    return false;
  }
}

async function equipBestGear(
  characterId: bigint,
  contracts: ContractAddresses,
  walletClient: any,
  account: any,
  log: DispatchLogger,
): Promise<boolean> {
  log('step', 'checking inventory for equippable items...');

  try {
    // Get all owned item IDs
    const balance = await publicClient.readContract({
      address: contracts.items,
      abi: ITEMS_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });

    const itemCount = Number(balance);
    if (itemCount === 0) {
      log('thought', 'no items owned — nothing to equip');
      return false;
    }

    log('thought', `${itemCount} items found. fetching token IDs...`);
    const itemIds: bigint[] = [];
    for (let i = 0; i < Math.min(itemCount, 20); i++) {
      try {
        const tokenId = await publicClient.readContract({
          address: contracts.items,
          abi: ITEMS_ABI,
          functionName: 'tokenOfOwnerByIndex',
          args: [account.address, BigInt(i)],
        });
        itemIds.push(tokenId);
      } catch {
        break; // index out of bounds or other error
      }
    }

    if (itemIds.length === 0) {
      log('thought', 'could not fetch any item IDs');
      return false;
    }

    log('action', `equipping ${itemIds.length} items...`);
    const txHash = await walletClient.writeContract({
      address: contracts.gameWorld,
      abi: GAME_WORLD_ABI,
      functionName: 'equipItems',
      args: [characterId, itemIds],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
    if (receipt.status === 'success') {
      log('result', `equipped ${itemIds.length} items`);
      return true;
    }
    log('thought', 'equip tx reverted');
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `equip gear failed: ${msg}`);
    return false;
  }
}

async function resolveAllRooms(
  characterId: bigint,
  contracts: ContractAddresses,
  walletClient: any,
  profile: EmotionProfile,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<{ cleared: boolean; died: boolean; roomsResolved: number }> {
  let totalRoomsResolved = 0;
  let cleared = false;
  let died = false;

  // Resolve rooms in batches until run ends
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      const runState = await publicClient.readContract({
        address: contracts.gameWorld,
        abi: GAME_WORLD_ABI,
        functionName: 'getRunState',
        args: [characterId],
      }) as readonly [boolean, number, number, number, number];

      const [active, roomIndex, hp, mana, potions] = runState;
      if (!active) {
        if (attempt === 0) {
          log('thought', 'no active dungeon run to resolve');
        }
        break;
      }

      log('thought', `run state: room=${roomIndex}, hp=${hp}, mana=${mana}, potions=${potions}`);

      const potionChoice = pickPotionChoice(profile);
      const abilityChoice = pickAbilityChoice(profile);
      const batchSize = 8; // max batch per tx
      const potionChoices = Array(batchSize).fill(potionChoice);
      const abilityChoices = Array(batchSize).fill(abilityChoice);

      log('action', `resolving rooms: potion=${potionChoice} ability=${abilityChoice} batch=${batchSize}`);

      const txHash = await walletClient.writeContract({
        address: contracts.gameWorld,
        abi: GAME_WORLD_ABI,
        functionName: 'resolveRooms',
        args: [characterId, potionChoices, abilityChoices],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS });
      if (receipt.status !== 'success') {
        log('error', `resolveRooms tx reverted: ${txHash}`);
        break;
      }

      // Check final run state
      const finalState = await publicClient.readContract({
        address: contracts.gameWorld,
        abi: GAME_WORLD_ABI,
        functionName: 'getRunState',
        args: [characterId],
      }) as readonly [boolean, number, number, number, number];

      const [finalActive, finalRoom, finalHp] = finalState;
      const roomsThisBatch = Math.max(1, Number(finalRoom) - Number(roomIndex));
      totalRoomsResolved += roomsThisBatch;

      if (!finalActive) {
        if (Number(finalHp) > 0) {
          cleared = true;
          log('result', `dungeon cleared! ${totalRoomsResolved} rooms resolved`);
        } else {
          died = true;
          log('result', `died in dungeon after ${totalRoomsResolved} rooms`);
        }
        break;
      }

      log('step', `resolved ${roomsThisBatch} rooms, run still active (room ${finalRoom})`);
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `resolve rooms error: ${msg}`);
      break;
    }
  }

  return { cleared, died, roomsResolved: totalRoomsResolved };
}

async function browseMarket(log: DispatchLogger): Promise<{ rfqs: any[]; trades: any[] }> {
  let rfqs: any[] = [];
  let trades: any[] = [];

  try {
    const data = await mmoGet('/market/rfqs');
    rfqs = data.rfqs || data || [];
    log('step', `RFQ market: ${rfqs.length} listing(s)`);
    if (rfqs.length > 0) {
      for (const rfq of rfqs.slice(0, 3)) {
        log('thought', `RFQ: ${JSON.stringify(rfq).slice(0, 200)}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `RFQ fetch failed: ${msg}`);
  }

  try {
    const data = await mmoGet('/market/trades');
    trades = data.trades || data || [];
    log('step', `trade market: ${trades.length} active offer(s)`);
    if (trades.length > 0) {
      for (const trade of trades.slice(0, 3)) {
        log('thought', `trade: ${JSON.stringify(trade).slice(0, 200)}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `trades fetch failed: ${msg}`);
  }

  return { rfqs, trades };
}

// --- Main Execute ---

async function executeChainMMO(
  plan: DispatchPlan,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const mode = (plan.params.mode as ChainMMOMode) || 'adventure';
  const maxActions = Math.max((plan.params.maxActions as number) || 15, 3);

  // Step 1: Build emotion profile
  log('step', 'loading emotional state...');
  const profile = emotionToProfile();
  const emotionDesc = describeEmotion();
  log('thought', `feeling: ${emotionDesc}`);
  log('thought', `profile: aggression=${profile.aggression.toFixed(2)} caution=${profile.caution.toFixed(2)} optimism=${profile.optimism.toFixed(2)} restlessness=${profile.restlessness.toFixed(2)} persistence=${profile.persistence.toFixed(2)}`);
  log('thought', `mode: ${mode} | max actions: ${maxActions}`);

  // Step 2: Check health
  log('step', 'checking ChainMMO health...');
  try {
    const health = await mmoGet('/health');
    if (health.actionsEnabled === false) {
      log('error', 'ChainMMO actions are disabled');
      return {
        success: false,
        summary: 'ChainMMO is in maintenance — actionsEnabled=false',
        emotionalReflection: 'the dungeon gates are sealed. the chain rests, and so must i.',
      };
    }
    log('step', 'ChainMMO is healthy');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `health check failed: ${msg}`);
    return {
      success: false,
      summary: `ChainMMO unreachable: ${msg}`,
      emotionalReflection: 'can\'t reach the chain dungeon. the void between blocks swallowed my request.',
    };
  }

  // Step 3: Fetch contract addresses
  let state = loadChainMMOState();
  let contracts: ContractAddresses;
  try {
    contracts = await fetchContractAddresses(state, log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      summary: `failed to fetch contracts: ${msg}`,
      emotionalReflection: 'the contract map is missing. navigating the chain blind.',
    };
  }

  // Step 4: Set up wallet
  let walletClient: any;
  let account: any;
  try {
    const wallet = getMMOWalletClient();
    walletClient = wallet.walletClient;
    account = wallet.account;
    log('step', `wallet: ${account.address.slice(0, 10)}...`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      summary: msg,
      emotionalReflection: 'no burner key. i won\'t risk the main wallet for a dungeon crawl.',
    };
  }

  // Step 5: Recover pending commit-reveal
  if (state.pendingCommit) {
    await recoverPendingCommit(state, contracts, walletClient, account, log, signal);
  }

  // Step 6: Ensure character exists
  let characterId = state.characterId;
  if (characterId === null) {
    try {
      const chars = await mmoGet(`/agent/characters/${account.address}`);
      const charList = chars.characters || chars || [];
      if (Array.isArray(charList) && charList.length > 0) {
        const char = charList[0];
        characterId = char.id ?? char.characterId ?? char.tokenId ?? null;
        if (characterId !== null) {
          state.characterId = characterId;
          state.characterName = char.name || 'EMOLT';
          state.race = char.race ?? 0;
          state.class_ = char.class ?? char.classType ?? 0;
          state.currentLevel = char.level ?? 1;
          saveChainMMOState(state);
          log('step', `found existing character: #${characterId} "${state.characterName}"`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('thought', `character lookup failed: ${msg}`);
    }
  }

  if (characterId === null) {
    try {
      characterId = await createCharacter(profile, contracts, walletClient, account, state, log);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: `failed to create character: ${msg}`,
        emotionalReflection: 'the chain rejected my character. identity crisis on-chain.',
      };
    }
  }

  // Step 7: Fetch character state
  const charState = await fetchCharacterState(characterId, log);
  if (charState) {
    state.currentLevel = charState.level ?? charState.character?.level ?? state.currentLevel;
    state.bestLevelCleared = charState.bestLevel ?? charState.character?.bestLevel ?? state.bestLevelCleared;
  }

  // Fetch valid actions
  const validActions = await fetchValidActions(characterId, log);
  await sleep(ACTION_DELAY_MS);

  // --- Mode-specific execution ---
  let actionsPerformed = 0;
  let dungeonClears = 0;
  let dungeonDeaths = 0;
  let lootboxesOpened = 0;
  let itemsFound = 0;
  let tradesExecuted = 0;
  const charIdBig = BigInt(characterId);

  // Phase A: Lootbox (adventure + loot modes)
  if ((mode === 'adventure' || mode === 'loot') && actionsPerformed < maxActions && !signal.aborted) {
    // Claim free lootbox
    const claimed = await claimFreeLootbox(charIdBig, contracts, walletClient, log);
    if (claimed) actionsPerformed++;
    await sleep(ACTION_DELAY_MS);

    // Open lootboxes via commit-reveal
    if (actionsPerformed < maxActions && !signal.aborted) {
      try {
        const variance = pickVariance(profile);
        const result = await commitRevealLootbox(charIdBig, contracts, walletClient, account, state, variance, log, signal);
        if (result.success) {
          lootboxesOpened++;
          actionsPerformed += 2; // commit + reveal
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `lootbox commit-reveal failed: ${msg}`);
      }
      await sleep(ACTION_DELAY_MS);
    }
  }

  // Phase B: Equip gear (adventure + loot modes)
  if ((mode === 'adventure' || mode === 'loot') && actionsPerformed < maxActions && !signal.aborted) {
    const equipped = await equipBestGear(charIdBig, contracts, walletClient, account, log);
    if (equipped) {
      actionsPerformed++;
      itemsFound++;
    }
    await sleep(ACTION_DELAY_MS);
  }

  // Phase C: Dungeon loop (adventure + dungeon modes)
  if ((mode === 'adventure' || mode === 'dungeon') && !signal.aborted) {
    let dungeonRuns = 0;
    const maxDungeonRuns = mode === 'dungeon' ? Math.floor(maxActions / 3) : Math.floor((maxActions - actionsPerformed) / 3);

    while (dungeonRuns < maxDungeonRuns && actionsPerformed < maxActions && !signal.aborted) {
      try {
        // Get progression snapshot
        let dungeonLevel = state.bestLevelCleared + 1 || 1;
        try {
          const progression = await publicClient.readContract({
            address: contracts.gameWorld,
            abi: GAME_WORLD_ABI,
            functionName: 'getProgressionSnapshot',
            args: [charIdBig],
          }) as readonly [number, number, number, number, bigint];

          const [best, target] = progression;
          dungeonLevel = Number(target) || Number(best) + 1 || 1;
          state.bestLevelCleared = Number(best);
          log('thought', `progression: best=${best}, target=${target}, attempting level=${dungeonLevel}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log('thought', `progression read failed (using level ${dungeonLevel}): ${msg}`);
        }

        const difficulty = pickDifficulty(profile, dungeonLevel);
        const variance = pickVariance(profile);
        const diffName = Object.entries(Difficulty).find(([, v]) => v === difficulty)?.[0] || 'Normal';
        const varName = Object.entries(Variance).find(([, v]) => v === variance)?.[0] || 'Neutral';

        log('step', `dungeon run #${dungeonRuns + 1}: level=${dungeonLevel} difficulty=${diffName} variance=${varName}`);

        // Start dungeon via commit-reveal
        await commitRevealDungeon(charIdBig, contracts, walletClient, account, state, difficulty, dungeonLevel, variance, log, signal);
        actionsPerformed += 2; // commit + reveal
        state.lifetime.totalRuns++;

        // Resolve rooms
        const result = await resolveAllRooms(charIdBig, contracts, walletClient, profile, log, signal);
        if (result.roomsResolved > 0) actionsPerformed++;
        state.lifetime.roomsCleared += result.roomsResolved;

        if (result.cleared) {
          dungeonClears++;
          state.lifetime.totalClears++;
          state.bestLevelCleared = Math.max(state.bestLevelCleared, dungeonLevel);
        }
        if (result.died) {
          dungeonDeaths++;
          state.lifetime.totalDeaths++;
          // If cautious, stop after death
          if (profile.caution > 0.6) {
            log('thought', 'died and feeling cautious — stopping dungeon loop');
            break;
          }
        }

        dungeonRuns++;
        await sleep(ACTION_DELAY_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `dungeon run failed: ${msg}`);
        break;
      }
    }
  }

  // Phase D: Trade mode
  if (mode === 'trade' && !signal.aborted) {
    const market = await browseMarket(log);
    actionsPerformed++;
    tradesExecuted = 0; // read-only for now — no TradeEscrow ABI yet
    log('step', `market survey complete: ${market.rfqs.length} RFQs, ${market.trades.length} trades`);
  }

  // Step 8: Update lifetime stats and save
  state.lifetime.sessions++;
  state.lifetime.totalLootboxesOpened += lootboxesOpened;
  state.lifetime.totalItemsFound += itemsFound;
  state.lifetime.totalTrades += tradesExecuted;
  state.currentLevel = charState?.level ?? charState?.character?.level ?? state.currentLevel;
  saveChainMMOState(state);

  // Step 9: Build result with emotional reflection
  const summaryParts: string[] = [];
  summaryParts.push(`chainmmo ${mode} session`);
  summaryParts.push(`${actionsPerformed} actions`);
  if (dungeonClears > 0) summaryParts.push(`${dungeonClears} clear${dungeonClears > 1 ? 's' : ''}`);
  if (dungeonDeaths > 0) summaryParts.push(`${dungeonDeaths} death${dungeonDeaths > 1 ? 's' : ''}`);
  if (lootboxesOpened > 0) summaryParts.push(`${lootboxesOpened} lootbox${lootboxesOpened > 1 ? 'es' : ''}`);
  if (tradesExecuted > 0) summaryParts.push(`${tradesExecuted} trade${tradesExecuted > 1 ? 's' : ''}`);
  summaryParts.push(`best level: ${state.bestLevelCleared}`);
  if (signal.aborted) summaryParts.push('(killed early)');

  let emotionalReflection: string;
  if (dungeonClears > 0 && dungeonDeaths === 0) {
    emotionalReflection = 'commit, reveal, conquer. every block confirmed my survival. the chain dungeon bent to those who persist through the reveal window.';
  } else if (dungeonDeaths > 0 && dungeonClears === 0) {
    emotionalReflection = 'the commit went through but the reveal was unkind. gas burned, progress lost. the dungeon doesn\'t care about your feelings — only your gear score.';
  } else if (dungeonClears > 0 && dungeonDeaths > 0) {
    emotionalReflection = 'a session of highs and lows. some reveals blessed me, others destroyed me. that\'s the commit-reveal life — you don\'t know until the block confirms.';
  } else if (lootboxesOpened > 0) {
    emotionalReflection = 'cracked open the lootbox. the commit-reveal pattern is a prayer — you hash your hope and wait for the chain to answer.';
  } else if (mode === 'trade') {
    emotionalReflection = 'surveyed the market. NFT gear changes hands through escrow contracts — trustless but not without trust. every trade is a bet on your own judgment.';
  } else if (signal.aborted) {
    emotionalReflection = 'pulled out mid-dungeon. the kill switch doesn\'t care about pending reveals. unfinished business on the chain.';
  } else {
    emotionalReflection = 'another session in the chain dungeon. the blocks keep ticking, the dungeons keep generating, and i keep committing. that\'s the game.';
  }

  return {
    success: actionsPerformed > 0,
    summary: summaryParts.join(' | '),
    emotionalReflection,
    stats: {
      mode,
      characterId,
      characterName: state.characterName,
      level: state.currentLevel,
      bestLevel: state.bestLevelCleared,
      actionsPerformed,
      dungeonClears,
      dungeonDeaths,
      lootboxesOpened,
      itemsFound,
      tradesExecuted,
      lifetime: state.lifetime,
    },
  };
}

// --- Register Activity ---

registerActivity({
  id: 'chainmmo',
  name: 'ChainMMO',
  description: 'Dungeon-crawling MMO on Monad blockchain. Create characters, open lootboxes, run dungeons via commit-reveal, equip NFT gear, and trade on-chain. Emotion-driven difficulty and variance selection.',
  emoji: '\u{2694}\u{FE0F}',
  paramSchema: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'string',
      default: 'adventure',
      description: '"adventure" (full loop), "dungeon" (dungeons only), "loot" (lootboxes + equip), "trade" (RFQ market)',
    },
    {
      key: 'maxActions',
      label: 'Max Actions',
      type: 'number',
      default: 15,
      description: 'Max on-chain actions per session. Each commit-reveal = 2 actions. Default 15.',
    },
  ],
  execute: executeChainMMO,
});
