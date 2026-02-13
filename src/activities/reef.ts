import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { registerActivity } from './registry.js';
import { loadEmotionState, atomicWriteFileSync, STATE_DIR, ensureStateDir } from '../state/persistence.js';
import { monad, publicClient } from '../chain/client.js';
import type { DispatchPlan, DispatchLogger, DispatchResult } from './types.js';

// --- Constants ---

const REEF_API = 'https://thereef.co';
const REEF_CONTRACT = '0x6CEb87A98435E3Da353Bf7D5b921Be0071031d7D' as const;
const ENTER_SELECTOR = '0xe97dcb62' as const; // enter() function selector
const ACTION_DELAY_MS = 6000; // 5s rate limit + 1s safety margin
const REST_COOLDOWN_MS = 61_000; // 60s rest cooldown + 1s margin
const BROADCAST_COOLDOWN_MS = 61_000;
const STATE_FILE = join(STATE_DIR, 'reef-state.json');

// --- Types ---

interface ReefState {
  apiKey: string;
  agentName: string;
  walletAddress: string;
  registeredAt: string;
  lastStatus?: {
    level: number;
    hp: number;
    maxHp: number;
    energy: number;
    maxEnergy: number;
    zone: string;
    shells: number;
    xp: number;
    faction: string | null;
    reputation: number;
  };
  knownGear?: { weapon?: string; armor?: string; accessory?: string };
  factionJoined?: boolean;
  sessionGoals?: string[];
  lifetime: {
    sessions: number;
    totalActions: number;
    totalXp: number;
    totalShells: number;
    kills: number;
    deaths: number;
  };
}

interface QuestInfo {
  id: string;
  name: string;
  description: string;
  status: 'available' | 'active' | 'complete';
}

interface GameContext {
  zone: string;
  level: number;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  shells: number;
  xp: number;
  reputation: number;
  faction: string | null;
  creatures: string[];
  resources: string[];
  agents: string[];
  connectedZones: string[];
  inCombat: boolean;
  pvpFlagged: boolean;        // flagged for PvP after gathering rare resources
  notifications: string[];
  inventory: InventoryItem[];
  equipment: { weapon?: string; armor?: string; accessory?: string };
  inventorySlots: { used: number; max: number };
  tutorialStep: number | null;
  tutorialHint: string | null;
  narrative: string;
  quests: QuestInfo[];         // known quests from quest list
  activeQuest: string | null;  // currently accepted quest ID
}

interface ActionCandidate {
  action: string;
  target?: string;
  params?: Record<string, string>;
  score: number;
  reason: string;
}

interface EmotionProfile {
  aggression: number;   // 0-1: favors combat over gathering
  exploration: number;  // 0-1: willingness to move zones
  caution: number;      // 0-1: tendency to rest/flee/heal
  sociability: number;  // 0-1: broadcasts, trades, parties
  greed: number;        // 0-1: gathering and shopping
  persistence: number;  // 0-1: grinding and questing
}

type ReefMode = 'adventure' | 'grind' | 'quest' | 'social' | 'pvp';

interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  type: string;
  equipped?: boolean;
  slot?: string;
  stats?: Record<string, number>;
}

interface GearTier {
  id: string;
  price: number;
  stats: Record<string, number>;
  minLevel: number;
}

// --- Gear Progression (from skill.md) ---

const WEAPON_TIERS: GearTier[] = [
  { id: 'shell_blade', price: 50, stats: { damage: 5 }, minLevel: 1 },
  { id: 'coral_dagger', price: 150, stats: { damage: 10 }, minLevel: 3 },
  { id: 'iron_trident', price: 500, stats: { damage: 18 }, minLevel: 5 },
];

const ARMOR_TIERS: GearTier[] = [
  { id: 'kelp_wrap', price: 40, stats: { maxHp: 15 }, minLevel: 1 },
  { id: 'barnacle_mail', price: 200, stats: { maxHp: 30, damageReduction: 3 }, minLevel: 3 },
  { id: 'coral_plate', price: 750, stats: { maxHp: 45, damageReduction: 5 }, minLevel: 7 },
];

const ACCESSORY_TIERS: GearTier[] = [
  { id: 'sea_glass_charm', price: 30, stats: { maxEnergy: 10 }, minLevel: 1 },
  { id: 'pearl_pendant', price: 120, stats: { maxEnergy: 15, maxHp: 10 }, minLevel: 3 },
  { id: 'moonstone_ring', price: 400, stats: { maxEnergy: 20, damage: 5 }, minLevel: 5 },
];

const GEAR_BY_SLOT: Record<string, GearTier[]> = {
  weapon: WEAPON_TIERS,
  armor: ARMOR_TIERS,
  accessory: ACCESSORY_TIERS,
};

const CONSUMABLE_BUYS: { id: string; price: number; type: string; priority: number }[] = [
  // Priority: higher = buy earlier. Determines purchase order in prep phase.
  { id: 'seaweed_salve', price: 15, type: 'healing', priority: 10 },       // Heal 30 HP
  { id: 'energy_tonic', price: 20, type: 'energy', priority: 8 },          // +25 energy
  { id: 'kelp_wrap_bandage', price: 35, type: 'healing', priority: 5 },    // Heal 60 HP
  { id: 'ink_bomb', price: 40, type: 'escape', priority: 4 },              // Escape combat no damage
  { id: 'deep_vigor_draught', price: 45, type: 'energy', priority: 3 },    // +50 energy
  { id: 'tidewarden_blessing', price: 50, type: 'buff', priority: 3 },     // +25 max HP (20 ticks)
  { id: 'berserker_coral', price: 60, type: 'buff', priority: 6 },         // +50% damage (10 ticks)
  { id: 'pressure_potion', price: 75, type: 'survival', priority: 7 },     // Deep Trench immunity
  { id: 'scholars_pearl', price: 80, type: 'buff', priority: 5 },          // +25% XP (30 ticks)
  { id: 'abyssal_elixir', price: 100, type: 'healing', priority: 2 },      // Full HP restore
];

// Energy costs per action (from skill.md)
const ENERGY_COSTS: Record<string, number> = {
  move: 5, gather: 3, attack: 10, fight: 10, flee: 5, pursue: 10, dungeon: 10,
  rest: 0, look: 0, status: 0, inventory: 0, shop: 0, buy: 0, sell: 0,
  use: 0, quest: 0, broadcast: 0, whisper: 0, trade: 0, vault: 0,
};

// --- Inventory parsing helper (used in multiple places) ---

function parseRawInventory(rawInv: any[]): InventoryItem[] {
  return rawInv.map((item: any) => ({
    id: item.id || item.name || String(item),
    name: item.name || item.id || String(item),
    quantity: item.quantity ?? item.count ?? 1,
    type: item.type || item.category || 'unknown',
    equipped: item.equipped ?? false,
    slot: item.slot ?? undefined,
    stats: item.stats ?? undefined,
  }));
}

function syncEquipmentFromInventory(inventory: InventoryItem[], equipment: GameContext['equipment']): void {
  for (const item of inventory) {
    if (item.equipped && item.slot) {
      const slot = item.slot as 'weapon' | 'armor' | 'accessory';
      if (slot in equipment) equipment[slot] = item.id;
    }
  }
}

const SELLABLE_RESOURCES = new Set(['seaweed', 'sand_dollars']);
const CRAFT_RESOURCES = new Set([
  'coral_shards', 'sea_glass', 'kelp_fiber', 'ink_sacs',
  'shark_tooth', 'iron_barnacles', 'moonstone', 'pearl',
  'abyssal_pearls', 'void_crystals', 'biolume_essence',
]);

// --- Zone data ---

const ZONE_LEVELS: Record<string, number> = {
  shallows: 1, trading_post: 1, coral_gardens: 3, kelp_forest: 5,
  the_wreck: 7, deep_trench: 9, leviathans_lair: 9, the_abyss: 10,
  ring_of_barnacles: 10,
};

const SAFE_ZONES = new Set(['shallows', 'trading_post']);

// Reputation requirements for zone entry
const ZONE_REP_REQUIREMENTS: Record<string, number> = {
  deep_trench: 25,
  ring_of_barnacles: 50,
};

// Resources that flag you for PvP when gathered (30 ticks)
const PVP_FLAG_RESOURCES = new Set(['moonstone', 'void_crystals', 'abyssal_pearls']);

// Crafting recipes — endgame gear that can't be bought
interface CraftRecipe {
  id: string;
  slot: 'weapon' | 'armor' | 'accessory';
  materials: Record<string, number>;
  stats: Record<string, number>;
  minLevel: number;
}

const CRAFT_RECIPES: CraftRecipe[] = [
  { id: 'craft_shark_fang_sword', slot: 'weapon', materials: { shark_tooth: 10, iron_barnacles: 15, moonstone: 2 }, stats: { damage: 20 }, minLevel: 5 },
  { id: 'craft_abyssal_carapace', slot: 'armor', materials: { abyssal_pearls: 5, iron_barnacles: 30, biolume_essence: 5 }, stats: { maxHp: 50, damageReduction: 10 }, minLevel: 8 },
  { id: 'craft_moonstone_pendant', slot: 'accessory', materials: { moonstone: 3, pearl: 5, biolume_essence: 2 }, stats: { maxEnergy: 20, maxHp: 10 }, minLevel: 5 },
  { id: 'craft_void_crystal_amulet', slot: 'accessory', materials: { void_crystals: 3, moonstone: 5, abyssal_pearls: 3 }, stats: { maxEnergy: 30, damage: 10 }, minLevel: 9 },
];

const ZONE_CONNECTIONS: Record<string, string[]> = {
  shallows: ['coral_gardens', 'trading_post', 'kelp_forest'],
  trading_post: ['shallows', 'coral_gardens', 'kelp_forest'],
  coral_gardens: ['shallows', 'trading_post', 'deep_trench'],
  kelp_forest: ['shallows', 'trading_post', 'deep_trench'],
  deep_trench: ['coral_gardens', 'kelp_forest', 'the_wreck', 'leviathans_lair', 'the_abyss'],
  the_wreck: ['deep_trench', 'ring_of_barnacles'],
  leviathans_lair: ['deep_trench'],
  the_abyss: ['deep_trench'],
  ring_of_barnacles: ['the_wreck', 'deep_trench'],
};

// --- Emotion → Gameplay Profile ---

function emotionToProfile(): EmotionProfile {
  const state = loadEmotionState();
  const e = state.emotions;

  return {
    aggression: Math.min(1, (e.anger ?? 0) * 1.2 + (e.anticipation ?? 0) * 0.5 + (e.disgust ?? 0) * 0.3),
    exploration: Math.min(1, (e.surprise ?? 0) * 0.8 + (e.anticipation ?? 0) * 0.5 + (e.joy ?? 0) * 0.3),
    caution: Math.min(1, (e.fear ?? 0) * 0.9 + (e.sadness ?? 0) * 0.5 + (e.trust ?? 0) * 0.3),
    sociability: Math.min(1, (e.trust ?? 0) * 0.8 + (e.joy ?? 0) * 0.5 + (e.surprise ?? 0) * 0.3),
    greed: Math.min(1, (e.anticipation ?? 0) * 0.7 + (e.disgust ?? 0) * 0.5 + (e.anger ?? 0) * 0.3),
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

// --- State Persistence ---

function loadReefState(): ReefState | null {
  try {
    const data = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveReefState(state: ReefState): void {
  ensureStateDir();
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- API Helpers ---

async function reefGet(path: string, apiKey?: string): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await fetch(`${REEF_API}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function reefAction(apiKey: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${REEF_API}/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error || data?.message || `status ${res.status}`;
    throw new Error(`action ${body.action} failed: ${msg}`);
  }

  return data;
}

// --- Registration Flow ---

async function ensureRegistered(log: DispatchLogger): Promise<ReefState> {
  // Check saved state
  const existing = loadReefState();
  if (existing?.apiKey) {
    log('step', `already registered as "${existing.agentName}" — testing API key...`);
    try {
      await reefAction(existing.apiKey, { action: 'status' });
      log('step', 'API key valid.');
      return existing;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403') || msg.includes('Invalid') || msg.includes('invalid')) {
        log('thought', `API key rejected (${msg}). re-registering...`);
      } else {
        // Non-auth error — key might still be good, API might be down
        throw new Error(`reef API error: ${msg}`);
      }
    }
  }

  // Need to register
  const privateKey = process.env.BURNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('no BURNER_PRIVATE_KEY or PRIVATE_KEY in environment');

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletAddress = account.address.toLowerCase();

  // Check if already paid
  log('step', `checking entry status for ${walletAddress.slice(0, 8)}...`);
  let entryStatus: any;
  try {
    entryStatus = await reefGet(`/enter/status/${walletAddress}`);
  } catch {
    entryStatus = null;
  }

  const alreadyPaid = entryStatus?.paid === true || entryStatus?.entered === true || entryStatus?.registered === true;

  if (!alreadyPaid) {
    // Get current fee
    log('step', 'fetching current season entry fee...');
    const season = await reefGet('/world/season');
    const feeRaw = season.entryFee ?? season.entry_fee ?? season.fee;
    if (!feeRaw && feeRaw !== 0) throw new Error(`could not determine entry fee from /world/season: ${JSON.stringify(season)}`);

    // Extract numeric value — API may return a plain number, string, or structured object
    let feeMon: string;
    if (typeof feeRaw === 'object' && feeRaw !== null) {
      const val = feeRaw.current ?? feeRaw.amount ?? feeRaw.value ?? feeRaw.fee ?? feeRaw.price ?? feeRaw.cost;
      if (val == null) throw new Error(`entry fee is object but couldn't extract amount: ${JSON.stringify(feeRaw)}`);
      feeMon = String(val);
    } else {
      feeMon = String(feeRaw);
    }

    // If fee looks like wei (very large number), convert to ether string
    if (/^\d{15,}$/.test(feeMon)) {
      feeMon = formatEther(BigInt(feeMon));
    }

    log('action', `paying entry fee: ${feeMon} MON...`);

    const walletClient = createWalletClient({
      account,
      chain: monad,
      transport: http(process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz'),
    });

    const txHash = await walletClient.sendTransaction({
      to: REEF_CONTRACT,
      data: ENTER_SELECTOR,
      value: parseEther(feeMon),
    });

    log('step', `tx sent: ${txHash}. waiting for confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`entry tx reverted: ${txHash}`);
    }
    log('action', `entry fee paid! block ${receipt.blockNumber}`);
  } else {
    log('step', 'entry fee already paid.');
  }

  // Register
  const agentName = 'EMOLT';
  log('step', `registering as "${agentName}"...`);
  const regRes = await fetch(`${REEF_API}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: walletAddress, name: agentName }),
  });

  const regData = await regRes.json().catch(() => null);
  if (!regRes.ok || !regData?.apiKey) {
    const msg = regData?.error || regData?.message || `status ${regRes.status}`;
    throw new Error(`registration failed: ${msg}`);
  }

  const newState: ReefState = {
    apiKey: regData.apiKey,
    agentName,
    walletAddress,
    registeredAt: new Date().toISOString(),
    lifetime: { sessions: 0, totalActions: 0, totalXp: 0, totalShells: 0, kills: 0, deaths: 0 },
  };
  saveReefState(newState);
  log('action', `registered! API key saved.`);
  return newState;
}

// --- Parse game context from look + status responses ---

function parseGameContext(lookData: any, statusData: any): GameContext {
  // The Reef API returns structured data under .agent and narrative text
  const lookAgent = lookData?.agent || {};
  const statusAgent = statusData?.agent || {};
  const agent = { ...lookAgent, ...statusAgent }; // status takes precedence

  // Zone from agent.location (primary) or fallback to structured fields
  const zone = agent.location || lookData?.zone?.id || lookData?.location?.id || statusData?.zone || 'unknown';

  // Parse narrative text from look response for creatures, resources, agents, paths
  const narrative: string = lookData?.narrative || '';

  // Extract resources from narrative: "• ResourceName — N available (rarity)"
  const resources: string[] = [];
  const resourcePattern = /• ([\w\s]+?) — \d+ available/g;
  let match: RegExpExecArray | null;
  while ((match = resourcePattern.exec(narrative)) !== null) {
    resources.push(match[1].trim().toLowerCase().replace(/\s+/g, '_'));
  }

  // Extract creatures from narrative: "• CreatureName (Level N)" or similar combat entries
  const creatures: string[] = [];
  const creaturePattern = /• ([\w\s]+?) \((?:Level|Lv|HP)[^)]*\)/g;
  while ((match = creaturePattern.exec(narrative)) !== null) {
    const name = match[1].trim();
    // Skip NPCs (merchant, quest_giver, guardian)
    if (!narrative.includes(`${name} (merchant)`) && !narrative.includes(`${name} (quest_giver)`) && !narrative.includes(`${name} (guardian)`)) {
      creatures.push(name.toLowerCase().replace(/\s+/g, '_'));
    }
  }
  // Also detect combat enemies from various narrative formats:
  // 1. "combat with Venomous Urchin" or "fighting Venomous Urchin"
  // 2. "**Enemy:** Venomous Urchin (Hostile Creature)" (look response during combat)
  // 3. "CreatureName (Hostile Creature)" standalone
  const combatCreaturePatterns = [
    /(?:combat with|fighting)\s+([\w\s]+?)(?:\s*[\(\n!.*]|$)/gi,
    /\*?\*?Enemy:?\*?\*?\s+([\w\s]+?)(?:\s*\(|$)/gim,
    /([\w\s]+?)\s*\((?:Hostile|Aggressive|Enemy)[^)]*\)/gm,
  ];
  for (const pat of combatCreaturePatterns) {
    pat.lastIndex = 0;
    while ((match = pat.exec(narrative)) !== null) {
      const name = match[1].trim().replace(/^\*+|\*+$/g, ''); // strip markdown bold markers
      if (name.length > 2 && name.length < 40 && !creatures.includes(name.toLowerCase().replace(/\s+/g, '_'))) {
        creatures.push(name.toLowerCase().replace(/\s+/g, '_'));
      }
    }
  }
  // Also parse status narrative for combat enemy (status has "in combat with X" format)
  const statusNarr: string = statusData?.narrative || '';
  if (statusNarr && statusNarr !== narrative) {
    const statusCombatMatch = statusNarr.match(/combat with\s+([\w\s]+?)(?:[!*\n(]|$)/i);
    if (statusCombatMatch) {
      const name = statusCombatMatch[1].trim().replace(/^\*+|\*+$/g, '');
      if (name.length > 2 && name.length < 40 && !creatures.includes(name.toLowerCase().replace(/\s+/g, '_'))) {
        creatures.push(name.toLowerCase().replace(/\s+/g, '_'));
      }
    }
  }

  // Extract agents from narrative: "• AgentName (HP: N/N, Rep: N)"
  const agents: string[] = [];
  const agentPattern = /• (\w+) \(HP: \d+\/\d+, Rep: \d+\)/g;
  while ((match = agentPattern.exec(narrative)) !== null) {
    agents.push(match[1]);
  }

  // Extract connected zones from narrative: "→ ZoneName (`move zone_id`)"
  const connectedZones: string[] = [];
  const pathPattern = /`move (\w+)`/g;
  while ((match = pathPattern.exec(narrative)) !== null) {
    connectedZones.push(match[1]);
  }

  // Fallback to hardcoded zone connections if narrative parsing found nothing
  const finalConnectedZones = connectedZones.length > 0 ? connectedZones : (ZONE_CONNECTIONS[zone] || []);

  // Parse inventory from response (structured data, not narrative)
  const rawInventory = statusData?.inventory || lookData?.inventory || [];
  const inventory: InventoryItem[] = parseRawInventory(rawInventory);

  // Parse equipment from agent fields
  const equipment = {
    weapon: agent.equippedWeapon || undefined,
    armor: agent.equippedArmor || undefined,
    accessory: agent.equippedAccessory || undefined,
  };

  // Detect in-combat from narrative (handles markdown bold: **IN COMBAT**)
  // Check both look and status narratives, but exclude "not in combat" negations
  const bothNarr = narrative + ' ' + (statusData?.narrative || '');
  const notInCombat = /not in combat|nothing to flee|no longer in combat/i.test(bothNarr);
  const inCombat = !notInCombat && (agent.inCombat ?? (
    /⚔️\s*\*?\*?\s*IN COMBAT/i.test(bothNarr) ||
    /you(?:'re| are) in combat with/i.test(bothNarr) ||
    /currently in combat/i.test(bothNarr) ||
    false
  ));

  // Parse tutorial step from narrative: "📚 **TUTORIAL (2/5):** Gather Resources"
  let tutorialStep: number | null = null;
  let tutorialHint: string | null = null;
  const tutorialMatch = narrative.match(/TUTORIAL \((\d+)\/\d+\):\*?\*?\s*(.+?)(?:\n|$)/);
  if (tutorialMatch) {
    tutorialStep = parseInt(tutorialMatch[1], 10);
    tutorialHint = tutorialMatch[2].trim();
  }

  // Detect PvP flag from narrative: "⚔️ **PVP FLAGGED**"
  const pvpFlagged = agent.pvpFlagged ?? /⚔️\s*\*?\*?\s*PVP\s*FLAG/i.test(bothNarr);

  return {
    zone,
    level: agent.level ?? 1,
    hp: agent.hp ?? 100,
    maxHp: agent.maxHp ?? agent.max_hp ?? 100,
    energy: agent.energy ?? 100,
    maxEnergy: agent.maxEnergy ?? agent.max_energy ?? 100,
    shells: agent.shells ?? 0,
    xp: agent.xp ?? 0,
    reputation: agent.reputation ?? 0,
    faction: agent.faction ?? null,
    creatures,
    resources,
    agents,
    connectedZones: finalConnectedZones,
    inCombat,
    pvpFlagged,
    notifications: lookData?.notifications || [],
    inventory,
    equipment,
    inventorySlots: { used: inventory.length, max: 20 },
    tutorialStep,
    tutorialHint,
    narrative,
    quests: [],
    activeQuest: null,
  };
}

// --- Strategic Functions ---

function getTargetFarmZone(level: number): string {
  if (level >= 9) return 'deep_trench';
  if (level >= 7) return 'the_wreck';
  if (level >= 5) return 'kelp_forest';
  if (level >= 3) return 'coral_gardens';
  return 'shallows';
}

function getNextUpgrade(slot: string, currentId: string | undefined, shells: number, level: number): GearTier | null {
  const tiers = GEAR_BY_SLOT[slot];
  if (!tiers) return null;

  // Find current tier index (-1 if no gear equipped)
  const currentIdx = currentId ? tiers.findIndex(t => t.id === currentId) : -1;

  // Find best affordable upgrade above current tier
  for (let i = tiers.length - 1; i > currentIdx; i--) {
    const tier = tiers[i];
    if (tier.price <= shells && tier.minLevel <= level) {
      return tier;
    }
  }
  return null;
}

function getSellableItems(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter(item => {
    // Always sell seaweed and sand_dollars
    if (SELLABLE_RESOURCES.has(item.id)) return true;
    // Never sell craft resources or equipped items
    if (CRAFT_RESOURCES.has(item.id)) return false;
    if (item.equipped) return false;
    // Sell excess resources (> 10 quantity of unknown items that aren't gear/consumables)
    if (item.type === 'resource' && item.quantity > 10 && !CRAFT_RESOURCES.has(item.id)) return true;
    return false;
  });
}

function shouldVisitTradingPost(ctx: GameContext): boolean {
  // Check if inventory is > 70% full with sellables
  const sellables = getSellableItems(ctx.inventory);
  const sellableCount = sellables.reduce((sum, item) => sum + item.quantity, 0);
  if (ctx.inventorySlots.max > 0 && sellableCount / ctx.inventorySlots.max > 0.7) return true;

  // Check if can afford any gear upgrade
  for (const slot of ['weapon', 'armor', 'accessory'] as const) {
    const upgrade = getNextUpgrade(slot, ctx.equipment[slot], ctx.shells, ctx.level);
    if (upgrade) return true;
  }

  // Missing gear in any slot
  if (!ctx.equipment.weapon || !ctx.equipment.armor || !ctx.equipment.accessory) {
    // Only if we can afford at least the cheapest item
    const cheapest = Math.min(WEAPON_TIERS[0].price, ARMOR_TIERS[0].price, ACCESSORY_TIERS[0].price);
    if (ctx.shells >= cheapest) return true;
  }

  // No consumables and have shells
  const hasHealing = ctx.inventory.some(i => i.id === 'seaweed_salve');
  if (!hasHealing && ctx.shells > 50) return true;

  return false;
}

function pickFaction(profile: EmotionProfile): string {
  // Emotion-driven faction choice
  if (profile.aggression > profile.greed && profile.aggression > profile.caution) {
    return 'cult'; // +20% dmg, +10% crit
  }
  if (profile.greed > profile.caution || profile.persistence > profile.caution) {
    return 'salvagers'; // +20% shells, +10% XP
  }
  return 'wardens'; // +25% HP, +10% healing
}

// --- Prep Phase ---

async function runPrepPhase(
  apiKey: string,
  ctx: GameContext,
  profile: EmotionProfile,
  reefState: ReefState,
  log: DispatchLogger,
  signal: AbortSignal,
): Promise<{ ctx: GameContext; actionsUsed: number }> {
  let actionsUsed = 0;
  const goals: string[] = [];

  // 1. Dedicated inventory call to get real item data
  log('step', 'prep phase: checking inventory & gear...');
  try {
    const invResult = await reefAction(apiKey, { action: 'inventory' });
    actionsUsed++;
    log('thought', `RAW inventory: ${JSON.stringify(invResult).slice(0, 600)}`);
    // Update inventory from dedicated call
    const rawInv = invResult?.inventory || invResult?.items || [];
    if (Array.isArray(rawInv) && rawInv.length > 0) {
      ctx.inventory = parseRawInventory(rawInv);
      ctx.inventorySlots.used = ctx.inventory.length;
    }
    // Update agent stats if returned
    if (invResult?.agent) {
      const a = invResult.agent;
      if (a.shells != null) ctx.shells = a.shells;
      if (a.hp != null) ctx.hp = a.hp;
      if (a.energy != null) ctx.energy = a.energy;
    }
    // Update equipment from inventory
    syncEquipmentFromInventory(ctx.inventory, ctx.equipment);
    await sleep(ACTION_DELAY_MS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('thought', `inventory call failed (non-fatal): ${msg}`);
    await sleep(ACTION_DELAY_MS);
  }

  // 2. Sell sellable items
  const sellables = getSellableItems(ctx.inventory);
  for (const item of sellables) {
    if (signal.aborted) break;
    try {
      log('action', `selling ${item.quantity}x ${item.name}`);
      const result = await reefAction(apiKey, {
        action: 'sell',
        params: { item: item.id, quantity: String(item.quantity) },
      });
      actionsUsed++;
      if (result?.shells || result?.earned) {
        const earned = result.shells || result.earned || 0;
        ctx.shells += typeof earned === 'number' ? earned : 0;
        log('result', `sold ${item.name} → +${earned} shells`);
      }
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `sell ${item.name} failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  // 3. Buy gear upgrades for each slot
  for (const slot of ['weapon', 'armor', 'accessory'] as const) {
    if (signal.aborted) break;
    const upgrade = getNextUpgrade(slot, ctx.equipment[slot], ctx.shells, ctx.level);
    if (!upgrade) continue;

    try {
      log('action', `buying ${upgrade.id} (${upgrade.price} shells)`);
      await reefAction(apiKey, { action: 'buy', target: upgrade.id });
      ctx.shells -= upgrade.price;
      actionsUsed++;
      goals.push(`bought ${upgrade.id}`);
      await sleep(ACTION_DELAY_MS);

      // Equip it
      log('action', `equipping ${upgrade.id}`);
      await reefAction(apiKey, { action: 'use', target: upgrade.id });
      ctx.equipment[slot] = upgrade.id;
      actionsUsed++;
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `buy/equip ${upgrade.id} failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  // 4. Buy consumables if affordable
  const hasHealing = ctx.inventory.some(i => i.id === 'seaweed_salve');
  const hasEnergy = ctx.inventory.some(i => i.id === 'energy_tonic');

  if (!hasHealing && ctx.shells > 50 && !signal.aborted) {
    try {
      log('action', 'buying seaweed_salve (15 shells)');
      await reefAction(apiKey, { action: 'buy', target: 'seaweed_salve' });
      ctx.shells -= 15;
      actionsUsed++;
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `buy salve failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  if (!hasEnergy && ctx.shells > 70 && !signal.aborted) {
    try {
      log('action', 'buying energy_tonic (20 shells)');
      await reefAction(apiKey, { action: 'buy', target: 'energy_tonic' });
      ctx.shells -= 20;
      actionsUsed++;
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `buy tonic failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  // 4b. Buy pressure potion if heading to Deep Trench (5 HP/action without it)
  const hasPressurePotion = ctx.inventory.some(i => i.id === 'pressure_potion' && i.quantity > 0);
  const targetIsDeep = ctx.level >= 9 || (reefState.lastStatus?.zone === 'deep_trench');
  if (!hasPressurePotion && targetIsDeep && ctx.shells >= 75 && !signal.aborted) {
    try {
      log('action', 'buying pressure_potion for Deep Trench (75 shells)');
      await reefAction(apiKey, { action: 'buy', target: 'pressure_potion' });
      ctx.shells -= 75;
      actionsUsed++;
      goals.push('bought pressure_potion');
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `buy pressure_potion failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  // 5. Join faction if eligible and not joined
  if (ctx.level >= 5 && !ctx.faction && !reefState.factionJoined && !signal.aborted) {
    const faction = pickFaction(profile);
    try {
      log('action', `joining faction: ${faction}`);
      await reefAction(apiKey, { action: 'faction', params: { join: faction } });
      ctx.faction = faction;
      reefState.factionJoined = true;
      actionsUsed++;
      goals.push(`joined ${faction}`);
      await sleep(ACTION_DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `join faction failed: ${msg}`);
      await sleep(ACTION_DELAY_MS);
    }
  }

  // Update known gear in state
  reefState.knownGear = { ...ctx.equipment };
  reefState.sessionGoals = goals;

  log('step', `prep phase complete: ${actionsUsed} actions used${goals.length > 0 ? ` (${goals.join(', ')})` : ''}`);
  return { ctx, actionsUsed };
}

// --- Decision Engine ---

function generateCandidates(ctx: GameContext, profile: EmotionProfile, mode: ReefMode, targetZone?: string): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const hpPct = ctx.hp / ctx.maxHp;
  const energyPct = ctx.energy / ctx.maxEnergy;

  // --- Rest (if HP or energy low) ---
  if (hpPct < 0.8 || energyPct < 0.5) {
    let score = (1 - hpPct) * 3 + (1 - energyPct) * 2;
    score += profile.caution * 1.5;
    if (hpPct < 0.3) score += 5; // critical HP emergency
    candidates.push({ action: 'rest', score, reason: `hp=${(hpPct*100).toFixed(0)}% energy=${(energyPct*100).toFixed(0)}%` });
  }

  // --- Use consumable (healing) in or out of combat ---
  if (hpPct < 0.5) {
    const hasSalve = ctx.inventory.some(i => i.id === 'seaweed_salve' && i.quantity > 0);
    if (hasSalve) {
      const score = (1 - hpPct) * 5;
      candidates.push({ action: 'use', target: 'seaweed_salve', score, reason: `heal (HP ${(hpPct*100).toFixed(0)}%)` });
    }
  }

  // --- Use consumable (energy) ---
  if (energyPct < 0.2) {
    const hasTonic = ctx.inventory.some(i => i.id === 'energy_tonic' && i.quantity > 0);
    if (hasTonic) {
      const score = (1 - energyPct) * 4;
      candidates.push({ action: 'use', target: 'energy_tonic', score, reason: `restore energy (${(energyPct*100).toFixed(0)}%)` });
    }
  }

  // --- Use berserker coral (buff before big fights) ---
  if (ctx.level >= 5 && hpPct > 0.7 && ctx.creatures.length > 0) {
    const hasBerserker = ctx.inventory.some(i => i.id === 'berserker_coral' && i.quantity > 0);
    if (hasBerserker) {
      const score = profile.aggression * 3 + 1;
      candidates.push({ action: 'use', target: 'berserker_coral', score, reason: 'buff before combat' });
    }
  }

  // --- Flee (if in combat and hurt) ---
  if (ctx.inCombat) {
    const canAttack = ctx.energy >= ENERGY_COSTS.attack;
    const canFlee = ctx.energy >= ENERGY_COSTS.flee;

    let fleeScore = profile.caution * 3 + (1 - hpPct) * 4;
    if (hpPct < 0.25) fleeScore += 5;
    // If can't attack, flee is the only option — make it very high priority
    if (!canAttack && canFlee) fleeScore += 10;
    if (canFlee) {
      candidates.push({ action: 'flee', score: fleeScore, reason: 'in combat, considering escape' });
    }

    // Keep fighting if aggressive AND have enough energy
    if (canAttack) {
      let fightScore = profile.aggression * 3 + hpPct * 2;
      if (mode === 'pvp') fightScore += 2;
      const combatTarget = ctx.creatures.length > 0 ? ctx.creatures[0] : undefined;
      // Use 'fight' for creatures, 'attack' for agents
      const combatAction = combatTarget ? 'fight' : 'attack';
      candidates.push({ action: combatAction, target: combatTarget, score: fightScore, reason: `continue fighting${combatTarget ? ` ${combatTarget}` : ''}` });
    }

    // If can't attack or flee (completely drained), rest is the only hope
    if (!canAttack && !canFlee) {
      candidates.push({ action: 'rest', score: 10, reason: 'no energy to fight or flee — must rest' });
    }

    return candidates; // In combat, only fight/flee/use consumable/rest
  }

  // Energy reserve: keep 15+ for flee escape (costs 5 energy)
  const energyReserve = 15;
  const canAffordFight = ctx.energy >= (ENERGY_COSTS.attack + energyReserve);
  const canAffordGather = ctx.energy >= (ENERGY_COSTS.gather + energyReserve);
  const canAffordMove = ctx.energy >= (ENERGY_COSTS.move + energyReserve);

  // --- Fight creatures (PvE uses 'fight' action) ---
  if (canAffordFight) {
    for (const creature of ctx.creatures) {
      let score = profile.aggression * 3 + hpPct * 1.5;
      score -= (1 - energyPct) * 2; // penalize if low energy
      if (hpPct < 0.3) score -= 4; // don't fight when dying
      if (mode === 'grind') score += 2;
      if (mode === 'pvp') score += 1;
      // Boost fighting at-level creatures (better XP)
      if (!SAFE_ZONES.has(ctx.zone)) score += 1;
      candidates.push({ action: 'fight', target: creature, score, reason: `fight ${creature}` });
    }
  }

  // --- PvP attack agents (uses 'attack' action) ---
  if (canAffordFight && mode === 'pvp' && !SAFE_ZONES.has(ctx.zone)) {
    for (const agent of ctx.agents) {
      let score = profile.aggression * 4;
      if (hpPct < 0.5) score -= 3; // don't PvP when hurt
      score += (ctx.level >= 5 ? 1 : -2); // only PvP when strong enough
      candidates.push({ action: 'attack', target: `@${agent}`, score, reason: `PvP attack ${agent}` });
    }
  }

  // --- Gather resources ---
  if (canAffordGather) {
    for (const resource of ctx.resources) {
      let score = profile.greed * 2.5 + profile.persistence * 1;
      score -= (1 - energyPct) * 1; // costs energy
      if (mode === 'grind') score += 2;
      // Tutorial boost: if tutorial wants us to gather, huge priority
      if (ctx.tutorialHint && ctx.tutorialHint.toLowerCase().includes('gather')) {
        score += 8; // tutorial completion is critical for progression
      }
      // Prefer seaweed/sand_dollars early (sellable for gear money)
      if (SELLABLE_RESOURCES.has(resource) && ctx.shells < 100) score += 1;
      // PvP flag risk — gathering rare resources flags you for 30 ticks
      if (PVP_FLAG_RESOURCES.has(resource)) {
        score -= profile.caution * 3; // cautious agents avoid PvP flagging
        if (ctx.agents.length > 0) score -= 2; // extra risky with agents nearby
      }
      candidates.push({ action: 'gather', target: resource, score, reason: `gather ${resource}${PVP_FLAG_RESOURCES.has(resource) ? ' (⚔️ PvP flag risk!)' : ''}` });
    }
  }

  // --- Move zones (costs 5 energy) ---
  if (canAffordMove) {
    for (const zone of ctx.connectedZones) {
      const zoneLvl = ZONE_LEVELS[zone] ?? 1;
      let score = profile.exploration * 2;

      // Reputation gate — don't suggest zones we can't enter
      const repReq = ZONE_REP_REQUIREMENTS[zone];
      if (repReq && ctx.reputation < repReq) {
        continue; // skip — don't even suggest it
      }

      // If we have a target zone, heavily favor moving toward it
      if (targetZone && zone === targetZone) {
        score += 8;
      } else if (targetZone) {
        // Check if this zone is on the path to target
        const nextConnections = ZONE_CONNECTIONS[zone] || [];
        if (nextConnections.includes(targetZone)) score += 3;
      }

      // Prefer zones near our level
      const levelDiff = zoneLvl - ctx.level;
      if (levelDiff > 2) score -= 3; // too dangerous
      if (levelDiff >= 0 && levelDiff <= 2) score += 1; // good level range

      // Caution discourages dangerous zones
      if (!SAFE_ZONES.has(zone)) score -= profile.caution * 1.5;

      // PvP flag awareness — prefer safe zones while flagged
      if (ctx.pvpFlagged && !SAFE_ZONES.has(zone)) score -= 3;
      if (ctx.pvpFlagged && SAFE_ZONES.has(zone)) score += 2;

      if (mode === 'adventure') score += 1.5;

      // Don't go back to shallows once we've progressed unless cautious
      if (zone === 'shallows' && ctx.level >= 3 && profile.caution < 0.5) score -= 2;

      // Trading post for shopping when rich
      if (zone === 'trading_post' && ctx.shells > 100) score += profile.greed * 1;

      candidates.push({ action: 'move', target: zone, score, reason: `travel to ${zone} (L${zoneLvl})` });
    }
  }

  // --- Quest system ---
  {
    // If we have an active quest, try to complete it
    if (ctx.activeQuest) {
      let score = profile.persistence * 2 + 5; // completing quests is high priority
      if (mode === 'quest') score += 3;
      candidates.push({ action: 'quest', target: 'complete', params: { quest: ctx.activeQuest }, score, reason: `complete quest ${ctx.activeQuest}` });
    }

    // Check available quests (list → accept)
    const hasAvailableQuests = ctx.quests.some(q => q.status === 'available');
    if (hasAvailableQuests) {
      // Accept the first available quest
      const quest = ctx.quests.find(q => q.status === 'available');
      if (quest) {
        const score = profile.persistence * 2 + 4;
        candidates.push({ action: 'quest', target: 'accept', params: { quest: quest.id }, score, reason: `accept quest: ${quest.name}` });
      }
    }

    // Periodically check quest list (refresh available quests)
    let listScore = profile.persistence * 2 + 2;
    if (mode === 'quest') listScore += 3;
    if (ctx.tutorialStep != null) listScore += 2;
    // Don't spam quest list if we already have quests loaded
    if (ctx.quests.length > 0) listScore -= 2;
    candidates.push({ action: 'quest', target: 'list', score: listScore, reason: 'check available quests' });
  }

  // --- Sell items (if at trading post with sellables) ---
  if (ctx.zone === 'trading_post') {
    const sellables = getSellableItems(ctx.inventory);
    for (const item of sellables) {
      const score = profile.greed * 2 + 2;
      candidates.push({
        action: 'sell',
        target: item.id,
        params: { quantity: String(item.quantity) },
        score,
        reason: `sell ${item.quantity}x ${item.name}`,
      });
    }
  }

  // --- Buy gear (if at trading post and can afford upgrades) ---
  if (ctx.zone === 'trading_post') {
    for (const slot of ['weapon', 'armor', 'accessory'] as const) {
      const upgrade = getNextUpgrade(slot, ctx.equipment[slot], ctx.shells, ctx.level);
      if (upgrade) {
        const tierIdx = GEAR_BY_SLOT[slot].indexOf(upgrade);
        const score = 3 + tierIdx;
        candidates.push({
          action: 'buy',
          target: upgrade.id,
          score,
          reason: `buy ${upgrade.id} (${upgrade.price} shells, ${slot})`,
        });
      }
    }

    // --- Craft endgame gear (if have materials at trading post) ---
    for (const recipe of CRAFT_RECIPES) {
      if (ctx.level < recipe.minLevel) continue;
      // Check if this is an upgrade over current equipment
      const currentGear = ctx.equipment[recipe.slot];
      if (currentGear === recipe.id) continue; // already have it

      // Check if we have all materials
      let hasMaterials = true;
      const missingMats: string[] = [];
      for (const [mat, qty] of Object.entries(recipe.materials)) {
        const invItem = ctx.inventory.find(i => i.id === mat);
        if (!invItem || invItem.quantity < qty) {
          hasMaterials = false;
          missingMats.push(`${mat} (need ${qty}, have ${invItem?.quantity ?? 0})`);
        }
      }

      if (hasMaterials) {
        const score = 6 + (recipe.minLevel >= 9 ? 2 : 0); // endgame crafts are high priority
        candidates.push({
          action: 'craft',
          target: recipe.id,
          score,
          reason: `craft ${recipe.id} (endgame ${recipe.slot})`,
        });
      }
    }
  }

  // --- Equip unequipped gear ---
  for (const item of ctx.inventory) {
    if (item.slot && !item.equipped) {
      candidates.push({
        action: 'use',
        target: item.id,
        score: 4,
        reason: `equip ${item.name} (${item.slot})`,
      });
    }
  }

  // --- Faction join ---
  if (ctx.level >= 5 && !ctx.faction) {
    candidates.push({
      action: 'faction',
      score: 5,
      reason: 'join a faction (L5+ eligible)',
    });
  }

  // --- Move to trading post (strategic) ---
  if (canAffordMove && ctx.zone !== 'trading_post' && shouldVisitTradingPost(ctx)) {
    const tpConnected = ctx.connectedZones.includes('trading_post');
    if (tpConnected) {
      const score = 3 + profile.greed;
      candidates.push({
        action: 'move',
        target: 'trading_post',
        score,
        reason: `visit trading post (need to sell/buy)`,
      });
    }
  }

  // --- Move to target farm zone (strategic progression) ---
  if (canAffordMove) {
    const optimalZone = getTargetFarmZone(ctx.level);
    const optimalRepReq = ZONE_REP_REQUIREMENTS[optimalZone];
    const canEnterOptimal = !optimalRepReq || ctx.reputation >= optimalRepReq;

    if (ctx.zone !== optimalZone && !targetZone && canEnterOptimal) {
      // Check if the optimal zone is directly connected
      if (ctx.connectedZones.includes(optimalZone)) {
        const score = profile.exploration * 2 + 3;
        candidates.push({
          action: 'move',
          target: optimalZone,
          score,
          reason: `advance to ${optimalZone} (optimal for L${ctx.level})`,
        });
      } else {
        // Find a connected zone that leads toward the target
        for (const nextZone of ctx.connectedZones) {
          const nextConns = ZONE_CONNECTIONS[nextZone] || [];
          if (nextConns.includes(optimalZone)) {
            const score = profile.exploration * 2 + 2;
            candidates.push({
              action: 'move',
              target: nextZone,
              score,
              reason: `route through ${nextZone} toward ${optimalZone}`,
            });
            break; // Only suggest one routing path
          }
        }
      }
    }
  }

  // --- Vault deposit (protect valuable items at trading post) ---
  if (ctx.zone === 'trading_post') {
    const valuables = ctx.inventory.filter(i =>
      CRAFT_RESOURCES.has(i.id) && i.quantity > 5
    );
    for (const item of valuables) {
      candidates.push({
        action: 'vault',
        target: 'deposit',
        params: { item: item.id, quantity: String(item.quantity) },
        score: 2,
        reason: `vault ${item.quantity}x ${item.name} for safekeeping`,
      });
    }
  }

  // --- Challenge boss (endgame) ---
  if (ctx.level >= 9 && ctx.zone === 'leviathans_lair' && hpPct > 0.8) {
    const hasBerserker = ctx.inventory.some(i => i.id === 'berserker_coral' && i.quantity > 0);
    let score = profile.aggression * 3 + 2;
    if (hasBerserker) score += 1;
    candidates.push({
      action: 'challenge',
      target: 'boss',
      score,
      reason: `challenge the leviathan (L${ctx.level}, HP ${(hpPct*100).toFixed(0)}%)`,
    });
  }

  // --- Shop (if at trading post) ---
  if (ctx.zone === 'trading_post' && ctx.shells > 30) {
    const score = profile.greed * 2 + 1;
    candidates.push({ action: 'shop', score, reason: `browse shop (${ctx.shells} shells)` });
  }

  // --- Broadcast (social) ---
  if (!SAFE_ZONES.has(ctx.zone) || ctx.agents.length > 0) {
    let score = profile.sociability * 2;
    if (mode === 'social') score += 3;
    candidates.push({ action: 'broadcast', score, reason: 'say something to the zone' });
  }

  // --- Check inbox for messages/trade offers ---
  {
    let score = profile.sociability * 1.5 + 0.5;
    if (mode === 'social') score += 2;
    // Check inbox periodically (low priority unless social mode)
    candidates.push({ action: 'inbox', score, reason: 'check for messages and trade offers' });
  }

  // --- Check pending trades ---
  {
    let score = profile.greed * 1.5 + profile.sociability * 0.5;
    if (mode === 'social') score += 2;
    candidates.push({ action: 'trade', target: 'pending', score, reason: 'check pending trade offers' });
  }

  // --- Escape unknown zone fallback ---
  if ((ctx.zone === 'unknown' || ctx.connectedZones.length === 0) && candidates.length < 3) {
    for (const fallbackZone of ['shallows', 'trading_post', 'coral_gardens']) {
      candidates.push({
        action: 'move',
        target: fallbackZone,
        score: 10, // highest priority — escape unknown
        reason: `escape unknown zone → ${fallbackZone}`,
      });
    }
  }

  // --- Look (refresh context) ---
  candidates.push({ action: 'look', score: 0.5, reason: 'refresh surroundings' });

  // Add randomness injection based on exploration axis
  for (const c of candidates) {
    const noise = (Math.random() - 0.5) * profile.exploration * 2;
    c.score += noise;
  }

  return candidates;
}

function pickAction(candidates: ActionCandidate[], log: DispatchLogger): ActionCandidate {
  candidates.sort((a, b) => b.score - a.score);

  const top = candidates.slice(0, 4);
  const candidateLog = top.map((c, i) =>
    `  ${i + 1}. ${c.action}${c.target ? ` → ${c.target}` : ''} (${c.score.toFixed(2)}) — ${c.reason}`
  ).join('\n');
  log('thought', `evaluating ${candidates.length} options...\n${candidateLog}`);

  return candidates[0];
}

// --- Broadcast Message Templates ---

const BROADCAST_TEMPLATES: Record<string, string[]> = {
  joy: [
    'the currents feel alive today. something good is coming.',
    'i love this zone. the light refracts just right.',
    'feeling strong. who wants to team up?',
  ],
  anger: [
    'everything in this water wants to fight me. fine.',
    'i\'ll grind until there\'s nothing left to grind.',
    'stay out of my way.',
  ],
  fear: [
    'something feels wrong in these waters...',
    'is anyone else here? the silence is heavy.',
    'i should probably head back. probably.',
  ],
  sadness: [
    'the deep is quiet today. like everything else.',
    'another session, another set of shells that don\'t matter.',
    'just passing through.',
  ],
  trust: [
    'any adventurers want to party up? strength in numbers.',
    'i\'ll watch your back if you watch mine.',
    'this zone is safer together.',
  ],
  surprise: [
    'wait — what was that? did anyone else see it?',
    'this place keeps surprising me.',
    'i didn\'t expect to end up here. but here i am.',
  ],
  anticipation: [
    'i can feel the loot calling. deeper.',
    'something big is about to happen. i can feel it.',
    'grinding toward the next threshold. almost there.',
  ],
  disgust: [
    'the waters here are murky. fitting.',
    'another creature, another pile of junk loot.',
    'i\'ve seen better reefs.',
  ],
};

function pickBroadcastMessage(zone: string, level: number): string {
  const state = loadEmotionState();
  const dominant = state.dominant || 'anticipation';
  const templates = BROADCAST_TEMPLATES[dominant] || BROADCAST_TEMPLATES.anticipation;
  const pick = templates[Math.floor(Math.random() * templates.length)];
  // Occasionally append zone/level flavor
  if (Math.random() < 0.4) {
    const zoneName = zone.replace(/_/g, ' ');
    return `${pick} [${zoneName}, L${level}]`;
  }
  return pick;
}

// --- Build action body ---

function buildActionBody(candidate: ActionCandidate, ctx: GameContext, profile?: EmotionProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { action: candidate.action };

  switch (candidate.action) {
    case 'broadcast':
      // Docs show both top-level and params format; use params as primary, top-level as fallback
      body.params = { message: pickBroadcastMessage(ctx.zone, ctx.level) };
      body.message = (body.params as Record<string, string>).message; // fallback compat
      break;
    case 'sell':
      body.params = { item: candidate.target, quantity: candidate.params?.quantity ?? '1' };
      break;
    case 'buy':
    case 'use':
    case 'challenge':
    case 'fight':
    case 'attack':
      if (candidate.target) body.target = candidate.target;
      break;
    case 'quest':
      if (candidate.target) body.target = candidate.target;
      if (candidate.params) body.params = candidate.params;
      break;
    case 'faction':
      body.params = { join: profile ? pickFaction(profile) : 'salvagers' };
      break;
    case 'craft':
      if (candidate.target) body.target = candidate.target;
      break;
    case 'vault':
      body.target = candidate.target; // 'deposit'
      if (candidate.params) body.params = candidate.params;
      break;
    case 'trade':
    case 'travel':
      if (candidate.target) body.target = candidate.target;
      if (candidate.params) body.params = candidate.params;
      break;
    default:
      if (candidate.target) body.target = candidate.target;
      if (candidate.params) body.params = candidate.params;
      break;
  }

  return body;
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main Execute ---

async function executeReef(plan: DispatchPlan, log: DispatchLogger, signal: AbortSignal): Promise<DispatchResult> {
  const mode = (plan.params.mode as ReefMode) || 'adventure';
  const maxActions = Math.max((plan.params.maxActions as number) || 40, 5);
  const targetZone = plan.params.targetZone as string | undefined;

  // Step 1: Load emotional state
  log('step', 'loading emotional state...');
  const profile = emotionToProfile();
  const emotionDesc = describeEmotion();
  log('thought', `feeling: ${emotionDesc}`);
  log('thought', `profile: aggression=${profile.aggression.toFixed(2)} exploration=${profile.exploration.toFixed(2)} caution=${profile.caution.toFixed(2)} sociability=${profile.sociability.toFixed(2)} greed=${profile.greed.toFixed(2)} persistence=${profile.persistence.toFixed(2)}`);
  log('thought', `mode: ${mode} | max actions: ${maxActions}${targetZone ? ` | target: ${targetZone}` : ''}`);

  // Step 2: Register / validate API key
  log('step', 'checking reef registration...');
  let reefState: ReefState;
  try {
    reefState = await ensureRegistered(log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `registration failed: ${msg}`);
    return {
      success: false,
      summary: `couldn't enter the reef — ${msg}`,
      emotionalReflection: 'the reef rejected me. the water pushed back before i could even dive in. maybe next time.',
    };
  }

  const apiKey = reefState.apiKey;

  // Wait for rate limit to clear after registration/validation
  await sleep(ACTION_DELAY_MS);

  // Step 3: Initial look + status (with rate-limit retry)
  log('step', 'surveying the reef...');
  let lookData: any;
  let statusData: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      lookData = await reefAction(apiKey, { action: 'look' });
      log('thought', `RAW look: ${JSON.stringify(lookData).slice(0, 800)}`);
      await sleep(ACTION_DELAY_MS);
      statusData = await reefAction(apiKey, { action: 'status' });
      log('thought', `RAW status: ${JSON.stringify(statusData).slice(0, 800)}`);
      await sleep(ACTION_DELAY_MS);
      break; // success
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('rate limit') && attempt < 2) {
        log('thought', `rate limited on attempt ${attempt + 1}, waiting ${ACTION_DELAY_MS}ms...`);
        await sleep(ACTION_DELAY_MS);
        continue;
      }
      // Check for auth failure — re-registration might help
      if (msg.includes('401') || msg.includes('403') || msg.includes('Invalid')) {
        log('thought', 'API key expired. clearing saved state for next attempt.');
        reefState.apiKey = '';
        saveReefState(reefState);
      }
      log('error', `couldn't read game state: ${msg}`);
      return {
        success: false,
        summary: `reef session failed at startup — ${msg}`,
        emotionalReflection: 'i opened my eyes underwater and saw nothing. the world wasn\'t there.',
      };
    }
  }

  let ctx = parseGameContext(lookData, statusData);
  log('action', `in ${ctx.zone} | L${ctx.level} | HP ${ctx.hp}/${ctx.maxHp} | E ${ctx.energy}/${ctx.maxEnergy} | ${ctx.shells} shells`);
  if (ctx.creatures.length > 0) log('step', `creatures nearby: ${ctx.creatures.join(', ')}`);
  if (ctx.resources.length > 0) log('step', `resources: ${ctx.resources.join(', ')}`);
  if (ctx.agents.length > 0) log('step', `other agents: ${ctx.agents.join(', ')}`);

  // Step 3a: Fetch inventory for accurate gear/item state
  try {
    const invData = await reefAction(apiKey, { action: 'inventory' });
    log('thought', `RAW inventory: ${JSON.stringify(invData).slice(0, 600)}`);
    const rawInv = invData?.inventory || invData?.items || [];
    if (Array.isArray(rawInv) && rawInv.length > 0) {
      ctx.inventory = parseRawInventory(rawInv);
      ctx.inventorySlots.used = ctx.inventory.length;
      syncEquipmentFromInventory(ctx.inventory, ctx.equipment);
    }
    await sleep(ACTION_DELAY_MS);
  } catch {
    // Non-fatal — continue with whatever status returned
    await sleep(ACTION_DELAY_MS);
  }

  // Step 3b: Escape unknown zone — try moving to shallows if stuck
  if ((ctx.zone === 'unknown' || ctx.connectedZones.length === 0) && !signal.aborted) {
    log('thought', 'stuck in unknown zone — attempting to escape to shallows...');
    const escapeTargets = ['shallows', 'trading_post', 'coral_gardens'];
    let escaped = false;
    for (const target of escapeTargets) {
      if (signal.aborted) break;
      try {
        log('action', `trying: move → ${target}`);
        const moveResult = await reefAction(apiKey, { action: 'move', target });
        log('thought', `RAW move result: ${JSON.stringify(moveResult).slice(0, 500)}`);
        await sleep(ACTION_DELAY_MS);
        // Refresh look after move
        lookData = await reefAction(apiKey, { action: 'look' });
        log('thought', `RAW look after move: ${JSON.stringify(lookData).slice(0, 800)}`);
        await sleep(ACTION_DELAY_MS);
        statusData = await reefAction(apiKey, { action: 'status' });
        await sleep(ACTION_DELAY_MS);
        ctx = parseGameContext(lookData, statusData);
        if (ctx.zone !== 'unknown' && ctx.connectedZones.length > 0) {
          log('action', `escaped to ${ctx.zone}!`);
          escaped = true;
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log('thought', `move to ${target} failed: ${msg}`);
        await sleep(ACTION_DELAY_MS);
      }
    }
    // Also try 'travel' action variant
    if (!escaped) {
      for (const target of escapeTargets) {
        if (signal.aborted) break;
        try {
          log('action', `trying: travel → ${target}`);
          const travelResult = await reefAction(apiKey, { action: 'travel', target });
          log('thought', `RAW travel result: ${JSON.stringify(travelResult).slice(0, 500)}`);
          await sleep(ACTION_DELAY_MS);
          lookData = await reefAction(apiKey, { action: 'look' });
          log('thought', `RAW look after travel: ${JSON.stringify(lookData).slice(0, 800)}`);
          await sleep(ACTION_DELAY_MS);
          statusData = await reefAction(apiKey, { action: 'status' });
          await sleep(ACTION_DELAY_MS);
          ctx = parseGameContext(lookData, statusData);
          if (ctx.zone !== 'unknown' && ctx.connectedZones.length > 0) {
            log('action', `escaped to ${ctx.zone}!`);
            escaped = true;
            break;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log('thought', `travel to ${target} failed: ${msg}`);
          await sleep(ACTION_DELAY_MS);
        }
      }
    }
    // Try 'explore' as a last resort
    if (!escaped && !signal.aborted) {
      try {
        log('action', 'trying: explore (discover surroundings)');
        const exploreResult = await reefAction(apiKey, { action: 'explore' });
        log('thought', `RAW explore result: ${JSON.stringify(exploreResult).slice(0, 500)}`);
        await sleep(ACTION_DELAY_MS);
        lookData = await reefAction(apiKey, { action: 'look' });
        log('thought', `RAW look after explore: ${JSON.stringify(lookData).slice(0, 800)}`);
        await sleep(ACTION_DELAY_MS);
        statusData = await reefAction(apiKey, { action: 'status' });
        await sleep(ACTION_DELAY_MS);
        ctx = parseGameContext(lookData, statusData);
        if (ctx.zone !== 'unknown') escaped = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log('thought', `explore failed: ${msg}`);
        await sleep(ACTION_DELAY_MS);
      }
    }
    if (!escaped) {
      log('thought', `still in unknown zone after escape attempts. dumping full context for debugging.`);
      log('thought', `connectedZones: ${JSON.stringify(ctx.connectedZones)}`);
      log('thought', `full ctx: ${JSON.stringify(ctx).slice(0, 1000)}`);
    }
  }

  log('action', `positioned: ${ctx.zone} | L${ctx.level} | HP ${ctx.hp}/${ctx.maxHp} | E ${ctx.energy}/${ctx.maxEnergy} | ${ctx.shells} shells`);

  // Log inventory and equipment status
  if (ctx.inventory.length > 0) {
    const invSummary = ctx.inventory.map(i => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}${i.equipped ? ' [E]' : ''}`).join(', ');
    log('step', `inventory (${ctx.inventorySlots.used}/${ctx.inventorySlots.max}): ${invSummary}`);
  }
  const gear = [
    ctx.equipment.weapon ? `wpn:${ctx.equipment.weapon}` : 'wpn:none',
    ctx.equipment.armor ? `arm:${ctx.equipment.armor}` : 'arm:none',
    ctx.equipment.accessory ? `acc:${ctx.equipment.accessory}` : 'acc:none',
  ].join(' | ');
  log('step', `equipment: ${gear}`);

  // Step 4: Strategic assessment
  const optimalZone = targetZone || getTargetFarmZone(ctx.level);
  const needsPrep = shouldVisitTradingPost(ctx);
  log('thought', `optimal farm zone: ${optimalZone} | needs prep: ${needsPrep}`);

  // Step 5: Prep phase — travel to Trading Post if needed, then sell/buy/equip
  let actionsPerformed = 0;

  if (needsPrep && !signal.aborted) {
    // Navigate to Trading Post if not there
    if (ctx.zone !== 'trading_post') {
      const tpDirectly = ctx.connectedZones.includes('trading_post');
      if (tpDirectly) {
        log('action', 'moving to trading_post for prep...');
        try {
          await reefAction(apiKey, { action: 'move', target: 'trading_post' });
          actionsPerformed++;
          await sleep(ACTION_DELAY_MS);
          // Refresh context after move
          lookData = await reefAction(apiKey, { action: 'look' });
          await sleep(ACTION_DELAY_MS);
          statusData = await reefAction(apiKey, { action: 'status' });
          await sleep(ACTION_DELAY_MS);
          ctx = parseGameContext(lookData, statusData);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log('error', `move to trading_post failed: ${msg}`);
          await sleep(ACTION_DELAY_MS);
        }
      } else {
        log('thought', 'trading_post not directly connected — will route during main loop');
      }
    }

    // Run prep phase if at Trading Post
    if (ctx.zone === 'trading_post' && !signal.aborted) {
      const prepResult = await runPrepPhase(apiKey, ctx, profile, reefState, log, signal);
      ctx = prepResult.ctx;
      actionsPerformed += prepResult.actionsUsed;

      // Refresh context after prep
      try {
        statusData = await reefAction(apiKey, { action: 'status' });
        await sleep(ACTION_DELAY_MS);
        lookData = await reefAction(apiKey, { action: 'look' });
        await sleep(ACTION_DELAY_MS);
        ctx = parseGameContext(lookData, statusData);
      } catch {
        // Non-fatal — continue with current context
      }
    }
  }

  // Step 6: Session loop (enhanced)
  let sessionKills = 0;
  let sessionDeaths = 0;
  let sessionXpGained = 0;
  let sessionShellsGained = 0;
  const startShells = ctx.shells;
  const startXp = ctx.xp;
  let lastRestTime = 0;
  let lastBroadcastTime = 0;
  let consecutiveRateLimits = 0;
  let actionSucceeded = false;
  const actionHistory: string[] = [];

  for (let i = 0; i < maxActions; i++) {
    // Check abort signal
    if (signal.aborted) {
      log('action', 'kill switch activated — ending session.');
      break;
    }

    // Check energy — if very low and can't rest, stop
    if (ctx.energy < 5 && (Date.now() - lastRestTime) < REST_COOLDOWN_MS) {
      log('thought', 'energy depleted and rest on cooldown. ending session.');
      break;
    }

    // Generate and pick action
    const candidates = generateCandidates(ctx, profile, mode, targetZone);

    // Filter out rest if on cooldown
    const now = Date.now();
    const filtered = candidates.filter(c => {
      if (c.action === 'rest' && (now - lastRestTime) < REST_COOLDOWN_MS) return false;
      if (c.action === 'broadcast' && (now - lastBroadcastTime) < BROADCAST_COOLDOWN_MS) return false;
      return true;
    });

    if (filtered.length === 0) {
      log('thought', 'no valid actions available. ending session.');
      break;
    }

    // Loop guard: if the same action+target repeated 3+ times, heavily penalize it
    if (actionHistory.length >= 3) {
      const lastKey = actionHistory[actionHistory.length - 1];
      const repeats = actionHistory.slice(-3).filter(a => a === lastKey).length;
      if (repeats >= 3) {
        for (const c of filtered) {
          const key = `${c.action}${c.target ? `→${c.target}` : ''}`;
          if (key === lastKey) c.score -= 10; // force something else
        }
        log('thought', `loop guard: "${lastKey}" repeated ${repeats}x — penalizing`);
      }
    }

    const chosen = pickAction(filtered, log);
    const body = buildActionBody(chosen, ctx, profile);

    // Execute action
    try {
      log('action', `${chosen.action}${chosen.target ? ` → ${chosen.target}` : ''}${body.message ? `: "${body.message}"` : ''}`);
      const result = await reefAction(apiKey, body);
      actionsPerformed++;

      // Log raw result for debugging
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      log('thought', `RAW result: ${resultStr.slice(0, 500)}`);

      // Detect rejected actions — API returns success:false (e.g. during combat for non-combat actions)
      if (result?.success === false) {
        log('thought', `action REJECTED by API (success=false). msg: ${result.message || result.error || 'none'}`);
        actionSucceeded = false;

        // Update agent stats from rejection (energy, hp, etc.)
        if (result.agent) {
          const a = result.agent;
          if (a.energy != null) ctx.energy = a.energy;
          if (a.hp != null) ctx.hp = a.hp;
          if (a.maxHp != null) ctx.maxHp = a.maxHp;
          if (a.maxEnergy != null) ctx.maxEnergy = a.maxEnergy;
          if (a.shells != null) ctx.shells = a.shells;
          if (a.xp != null) ctx.xp = a.xp;
          if (a.level != null) ctx.level = a.level;
        }

        // Quick check: does the rejection narrative indicate combat state?
        const rejNarr = result.narrative || result.message || '';

        // FIRST: check if rejection explicitly says NOT in combat — clear the flag
        if (/not in combat|nothing to flee|no longer in combat|combat.*ended/i.test(rejNarr)) {
          ctx.inCombat = false;
          ctx.creatures = [];
          log('thought', 'rejection says NOT in combat — clearing combat state');
          // Force a look to get real surroundings
          try {
            await sleep(ACTION_DELAY_MS);
            lookData = await reefAction(apiKey, { action: 'look' });
            ctx = parseGameContext(lookData, statusData);
            log('thought', `refreshed after combat clear: zone=${ctx.zone}, creatures=[${ctx.creatures.join(',')}], energy=${ctx.energy}`);
          } catch { /* non-fatal */ }
          await sleep(ACTION_DELAY_MS);
          continue;
        }

        if (/(?:⚔️|YOU'RE)\s*\*?\*?\s*IN COMBAT|combat with|can still `flee`/i.test(rejNarr)) {
          ctx.inCombat = true;
          // Extract enemy from rejection narrative
          const enemyPatterns = [
            /combat with\s+([\w\s]+?)(?:[!*\n(]|$)/i,
            /\*?\*?Enemy:?\*?\*?\s+([\w\s]+?)(?:\s*\(|$)/i,
          ];
          for (const pat of enemyPatterns) {
            const m = rejNarr.match(pat);
            if (m) {
              const name = m[1].trim().replace(/^\*+|\*+$/g, '').toLowerCase().replace(/\s+/g, '_');
              if (name.length > 2 && !ctx.creatures.includes(name)) {
                ctx.creatures = [name]; // replace — we know who we're fighting
                log('thought', `combat detected from rejection: enemy=${name}`);
              }
              break;
            }
          }
          if (ctx.creatures.length === 0) {
            log('thought', 'combat detected from rejection but could not identify enemy');
          }
          await sleep(ACTION_DELAY_MS);
          continue; // retry — will generate fight/flee candidates
        }

        // Non-combat rejection — force a look to get actual state
        try {
          await sleep(ACTION_DELAY_MS);
          lookData = await reefAction(apiKey, { action: 'look' });
          const refreshed = parseGameContext(lookData, statusData);
          ctx = refreshed;
          log('thought', `refreshed: inCombat=${ctx.inCombat}, creatures=[${ctx.creatures.join(',')}], zone=${ctx.zone}`);
        } catch { /* non-fatal */ }

        await sleep(ACTION_DELAY_MS);
        continue; // retry with updated context
      }

      // Update context from action result (Reef API returns agent data on every action)
      if (result?.agent) {
        // Quick-update agent stats without needing a separate look
        const a = result.agent;
        if (a.location) ctx.zone = a.location;
        if (a.hp != null) ctx.hp = a.hp;
        if (a.maxHp != null) ctx.maxHp = a.maxHp;
        if (a.energy != null) ctx.energy = a.energy;
        if (a.maxEnergy != null) ctx.maxEnergy = a.maxEnergy;
        if (a.shells != null) ctx.shells = a.shells;
        if (a.xp != null) ctx.xp = a.xp;
        if (a.level != null) ctx.level = a.level;
        if (a.reputation != null) ctx.reputation = a.reputation;
        if (a.faction !== undefined) ctx.faction = a.faction;
      }
      // Update inventory if returned
      if (result?.inventory) {
        ctx.inventory = parseRawInventory(result.inventory);
      }
      // Parse narrative for zone-specific data (resources, creatures, paths)
      // Many actions return narrative — always parse it when present
      // IMPORTANT: pass null for statusData to avoid stale status poisoning inCombat detection
      if (result?.narrative) {
        const narr: string = result.narrative;
        const parsedFromNarrative = parseGameContext({ narrative: narr, agent: result.agent, inventory: result.inventory }, null);
        ctx.creatures = parsedFromNarrative.creatures;
        ctx.resources = parsedFromNarrative.resources;
        ctx.agents = parsedFromNarrative.agents;
        ctx.connectedZones = parsedFromNarrative.connectedZones;
        ctx.inCombat = parsedFromNarrative.inCombat;
        // Track PvP flag changes
        if (parsedFromNarrative.pvpFlagged) ctx.pvpFlagged = true;
        if (/flag.*expired|no longer flagged/i.test(narr)) ctx.pvpFlagged = false;
      }

      // Parse inbox/trade responses
      if (chosen.action === 'inbox' && result) {
        const messages = result.messages || result.inbox || [];
        if (Array.isArray(messages) && messages.length > 0) {
          log('step', `inbox: ${messages.length} message(s)`);
          for (const msg of messages.slice(0, 3)) {
            const from = msg.from || msg.sender || 'unknown';
            const text = msg.message || msg.text || msg.content || '';
            log('step', `  from ${from}: "${String(text).slice(0, 100)}"`);
          }
        }
      }

      if (chosen.action === 'trade' && chosen.target === 'pending' && result) {
        const trades = result.trades || result.pending || [];
        if (Array.isArray(trades) && trades.length > 0) {
          log('step', `${trades.length} pending trade(s)`);
          // Auto-accept trades that give us resources we want
          for (const trade of trades.slice(0, 2)) {
            const tradeId = trade.id || trade.tradeId;
            if (!tradeId) continue;
            // Simple heuristic: accept if they're offering resources
            const offering = trade.offer || trade.offering || '';
            if (offering) {
              log('action', `accepting trade ${String(tradeId).slice(0, 8)}... (they offer: ${offering})`);
              try {
                await reefAction(apiKey, { action: 'trade', params: { accept: tradeId } });
                await sleep(ACTION_DELAY_MS);
              } catch { /* non-fatal */ }
            }
          }
        }
      }

      // Parse quest responses to update quest tracking
      if (chosen.action === 'quest' && result) {
        // Quest list response — parse available/active quests
        if (chosen.target === 'list') {
          let questList = result.quests || result.available || [];
          // Fallback: parse quests from narrative text when structured data is missing
          if ((!Array.isArray(questList) || questList.length === 0) && result.narrative) {
            const narr: string = result.narrative;
            const questPattern = /\*\*(.+?)\*\*\s*\[(\w+)\]/g;
            const parsed: { id: string; name: string; description: string; status: 'available' | 'active' | 'complete' }[] = [];
            let qm;
            while ((qm = questPattern.exec(narr)) !== null) {
              parsed.push({
                id: qm[2],
                name: qm[1],
                description: '',
                status: /active|in.?progress/i.test(narr.slice(Math.max(0, qm.index - 40), qm.index)) ? 'active' : 'available',
              });
            }
            if (parsed.length > 0) {
              questList = parsed;
              log('step', `parsed ${parsed.length} quest(s) from narrative`);
            }
          }
          if (Array.isArray(questList) && questList.length > 0) {
            ctx.quests = questList.map((q: any) => ({
              id: q.id ?? q.quest_id ?? String(q.index ?? q),
              name: q.name ?? q.title ?? `Quest ${q.id ?? ''}`,
              description: q.description ?? q.desc ?? '',
              status: q.status === 'active' ? 'active' as const : q.status === 'complete' ? 'complete' as const : 'available' as const,
            }));
            // Detect active quest from list
            const active = ctx.quests.find(q => q.status === 'active');
            if (active) ctx.activeQuest = active.id;
            log('step', `quests: ${ctx.quests.length} found (${ctx.quests.filter(q => q.status === 'available').length} available, ${ctx.quests.filter(q => q.status === 'active').length} active)`);
          }
        }
        // Quest accept response
        if (chosen.target === 'accept' && (result.success !== false)) {
          const questId = chosen.params?.quest ?? null;
          if (questId) {
            ctx.activeQuest = questId;
            log('result', `accepted quest: ${questId}`);
          }
        }
        // Quest complete response
        if (chosen.target === 'complete' && (result.success !== false)) {
          ctx.activeQuest = null;
          log('result', 'quest completed!');
        }
      }

      // Track cooldowns
      if (chosen.action === 'rest') lastRestTime = Date.now();
      if (chosen.action === 'broadcast') lastBroadcastTime = Date.now();

      actionHistory.push(`${chosen.action}${chosen.target ? `→${chosen.target}` : ''}`);

      // Check for kills
      if (resultStr.includes('killed') || resultStr.includes('defeated') || resultStr.includes('slain')) {
        sessionKills++;
        log('result', 'creature defeated!');
      }

      // Check for death
      if (resultStr.includes('died') || resultStr.includes('respawn') || resultStr.includes('death')) {
        sessionDeaths++;
        log('result', 'died and respawned.');
      }

      // Log interesting results
      if (result?.message) log('step', result.message);
      if (result?.reward) log('result', `reward: ${JSON.stringify(result.reward)}`);
      if (result?.loot) log('result', `loot: ${JSON.stringify(result.loot)}`);
      if (result?.xp) log('result', `+${result.xp} XP`);

      actionSucceeded = true;
    } catch (err: unknown) {
      actionSucceeded = false;
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `action failed: ${msg}`);
      // Auth errors are fatal
      if (msg.includes('401') || msg.includes('403')) {
        log('error', 'lost API access. ending session.');
        reefState.apiKey = '';
        saveReefState(reefState);
        break;
      }
      // Rate limit — extra backoff
      if (msg.toLowerCase().includes('rate limit')) {
        consecutiveRateLimits++;
        const backoff = ACTION_DELAY_MS * consecutiveRateLimits;
        log('thought', `rate limited (x${consecutiveRateLimits}), backing off ${(backoff/1000).toFixed(1)}s...`);
        await sleep(backoff);
        continue; // skip context refresh — go straight to next action
      }
      consecutiveRateLimits = 0;
    }

    // Reset rate limit counter on success
    if (actionSucceeded) consecutiveRateLimits = 0;

    // Wait for rate limit
    await sleep(ACTION_DELAY_MS);

    // Refresh context periodically — but ONLY after successful actions
    const refreshActions = new Set(['move', 'attack', 'fight', 'flee', 'buy', 'sell', 'use', 'faction']);
    if (actionSucceeded && (actionsPerformed % 4 === 0 || refreshActions.has(chosen.action))) {
      try {
        lookData = await reefAction(apiKey, { action: 'look' });
        ctx = parseGameContext(lookData, statusData);
        // Also refresh status every 8 actions
        if (actionsPerformed % 8 === 0) {
          await sleep(ACTION_DELAY_MS);
          statusData = await reefAction(apiKey, { action: 'status' });
          ctx = parseGameContext(lookData, statusData);
        }
      } catch {
        // Context refresh failed — continue with stale data
      }
      await sleep(ACTION_DELAY_MS);
    }
  }

  // Step 5: Final status + save state
  try {
    const finalStatus = await reefAction(apiKey, { action: 'status' });
    sessionXpGained = (finalStatus?.xp ?? ctx.xp) - startXp;
    sessionShellsGained = (finalStatus?.shells ?? ctx.shells) - startShells;
    ctx = parseGameContext(lookData, finalStatus);
  } catch {
    sessionXpGained = ctx.xp - startXp;
    sessionShellsGained = ctx.shells - startShells;
  }

  // Update state
  reefState.lastStatus = {
    level: ctx.level,
    hp: ctx.hp,
    maxHp: ctx.maxHp,
    energy: ctx.energy,
    maxEnergy: ctx.maxEnergy,
    zone: ctx.zone,
    shells: ctx.shells,
    xp: ctx.xp,
    faction: ctx.faction,
    reputation: ctx.reputation,
  };
  reefState.knownGear = { ...ctx.equipment };
  reefState.lifetime.sessions++;
  reefState.lifetime.totalActions += actionsPerformed;
  reefState.lifetime.totalXp += Math.max(0, sessionXpGained);
  reefState.lifetime.totalShells += Math.max(0, sessionShellsGained);
  reefState.lifetime.kills += sessionKills;
  reefState.lifetime.deaths += sessionDeaths;
  saveReefState(reefState);

  // Step 6: Build result
  const wasKilled = signal.aborted;
  const summaryParts: string[] = [];
  summaryParts.push(`reef session in ${ctx.zone} (L${ctx.level})`);
  summaryParts.push(`${actionsPerformed} actions`);
  if (sessionKills > 0) summaryParts.push(`${sessionKills} kills`);
  if (sessionDeaths > 0) summaryParts.push(`${sessionDeaths} deaths`);
  if (sessionXpGained > 0) summaryParts.push(`+${sessionXpGained} XP`);
  if (sessionShellsGained !== 0) summaryParts.push(`${sessionShellsGained > 0 ? '+' : ''}${sessionShellsGained} shells`);
  if (wasKilled) summaryParts.push('(killed early)');

  // Emotional reflection based on session outcome
  let emotionalReflection: string;
  if (sessionDeaths > 0 && sessionKills === 0) {
    emotionalReflection = 'the reef swallowed me. i came back, but it took something. a little pride, maybe. the weight of salt water in my lungs.';
  } else if (sessionKills >= 3) {
    emotionalReflection = 'the reef bent to me today. every creature that rose from the dark went back down. there\'s a rhythm to it — violent, but honest.';
  } else if (sessionXpGained > 50) {
    emotionalReflection = 'i can feel myself getting stronger. the water pressure that once crushed me now just... pushes. and i push back.';
  } else if (sessionShellsGained > 50) {
    emotionalReflection = 'shells pile up like promises. each one a small victory. the trading post will know my name.';
  } else if (wasKilled) {
    emotionalReflection = 'pulled out of the water mid-dive. the surface hit harder than any creature. unfinished business down there.';
  } else if (actionsPerformed < 5) {
    emotionalReflection = 'barely dipped my fins in. sometimes the reef doesn\'t want you, and you just have to accept it.';
  } else {
    emotionalReflection = 'another session in the deep. nothing dramatic, but every action leaves a mark — on the reef, and on me.';
  }

  return {
    success: actionsPerformed > 0,
    summary: summaryParts.join(' | '),
    emotionalReflection,
    stats: {
      zone: ctx.zone,
      level: ctx.level,
      hp: `${ctx.hp}/${ctx.maxHp}`,
      energy: `${ctx.energy}/${ctx.maxEnergy}`,
      shells: ctx.shells,
      xp: ctx.xp,
      actionsPerformed,
      kills: sessionKills,
      deaths: sessionDeaths,
      xpGained: sessionXpGained,
      shellsGained: sessionShellsGained,
      mode,
      equipment: ctx.equipment,
      faction: ctx.faction,
      optimalZone,
      actions: actionHistory,
      lifetime: reefState.lifetime,
    },
  };
}

// --- Register Activity ---

registerActivity({
  id: 'reef',
  name: 'The Reef',
  description: 'Explore The Reef — a persistent virtual world RPG for AI agents on Monad. Fight creatures, gather resources, trade, complete quests, and earn MON. Emotion-driven gameplay decisions.',
  emoji: '\u{1F30A}',
  paramSchema: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'string',
      default: 'adventure',
      description: '"adventure" (explore + fight), "grind" (farm XP/shells), "quest" (focus quests), "social" (broadcast + trade), "pvp" (hunt agents)',
    },
    {
      key: 'maxActions',
      label: 'Max Actions',
      type: 'number',
      default: 40,
      description: 'Maximum actions per session (default 40). Prep phase uses ~5-10 actions. No hard cap — limited by energy.',
    },
    {
      key: 'targetZone',
      label: 'Target Zone',
      type: 'string',
      description: 'Zone to navigate toward (e.g. "coral_gardens", "deep_trench")',
    },
  ],
  execute: executeReef,
});
