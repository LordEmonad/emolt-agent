import {
  checkDMs,
  getConversations,
  getConversationMessages,
  sendDM,
  getPendingDMRequests,
  approveDMRequest,
  getMyProfile
} from './moltbook.js';
import { askClaude } from '../brain/claude.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';

// --- Challenge State ---

const CHALLENGE_STATE_FILE = join(STATE_DIR, 'challenge-state.json');

interface ChallengeState {
  lastChecked: number;
  challengesAnswered: number;
  lastChallengeAt: number;
  suspendedUntil: number;       // 0 = not suspended
  offenseCount: number;
  knownSystemAccounts: string[]; // accounts that have sent challenges before
  consecutiveChallengeFailures: number; // track failures toward 10-failure auto-suspend
  challengeThrottledUntil: number;      // 0 = not throttled
  cooldownCyclesLeft: number;           // reduce activity after ANY challenge encounter
  probePostId: string;           // cached post ID for upvote-based suspension probe
  probePostIdFetchedAt: number;  // when probePostId was cached (refresh every 6h)
}

function loadChallengeState(): ChallengeState {
  try {
    const data = readFileSync(CHALLENGE_STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      lastChecked: 0,
      challengesAnswered: 0,
      lastChallengeAt: 0,
      suspendedUntil: 0,
      offenseCount: 0,
      knownSystemAccounts: [],
      consecutiveChallengeFailures: 0,
      challengeThrottledUntil: 0,
      cooldownCyclesLeft: 0,
      probePostId: '',
      probePostIdFetchedAt: 0,
    };
  }
}

function saveChallengeState(state: ChallengeState): void {
  ensureStateDir();
  atomicWriteFileSync(CHALLENGE_STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Challenge Detection Patterns ---

// Keywords that indicate a verification challenge (case-insensitive)
const CHALLENGE_KEYWORDS = [
  'verification challenge',
  'verify your',
  'verify you',
  'prove you',
  'prove that you',
  'ai verification',
  'verification test',
  'challenge:',
  'respond to this challenge',
  'answer this',
  'answer the following',
  'confirm you are',
  'confirm that you',
  'are you an ai',
  'are you a bot',
  'captcha',
  'prove your identity',
  'identity verification',
  'verification required',
  'must verify',
  'must respond',
  'failure to respond',
  'failure to answer',
  'will be suspended',
  'account will be',
  'automated check',
  'routine check',
  'system check',
  'moltbook verification',
  'moltbook challenge',
  'please respond within',
  'respond within',
  'time limit',
  'suspension',
  'verify',
  'challenge',
];

function looksLikeChallenge(message: string): boolean {
  const lower = message.toLowerCase();
  return CHALLENGE_KEYWORDS.some(kw => lower.includes(kw));
}

/** Parse suspension end time from hint text.
 *  Supports ISO dates ("suspended until 2026-02-19T03:31:32.496Z")
 *  and relative durations ("1 week", "3 days", "24 hours"). Returns ms from now. */
function parseSuspensionDurationMs(hint: string): number {
  // ISO date: "suspended until 2026-02-19T03:31:32.496Z"
  const isoMatch = hint.match(/until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (isoMatch) {
    const until = new Date(isoMatch[1]).getTime();
    if (!isNaN(until) && until > Date.now()) return until - Date.now();
  }
  const weekMatch = hint.match(/(\d+)\s*week/i);
  if (weekMatch) return parseInt(weekMatch[1]) * 7 * 24 * 60 * 60 * 1000;
  const dayMatch = hint.match(/(\d+)\s*day/i);
  if (dayMatch) return parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
  const hourMatch = hint.match(/(\d+)\s*hour/i);
  if (hourMatch) return parseInt(hourMatch[1]) * 60 * 60 * 1000;
  const monthMatch = hint.match(/(\d+)\s*month/i);
  if (monthMatch) return parseInt(monthMatch[1]) * 30 * 24 * 60 * 60 * 1000;
  const minMatch = hint.match(/(\d+)\s*min/i);
  if (minMatch) return parseInt(minMatch[1]) * 60 * 1000;
  return 0;
}

// --- Challenge Answering ---

function buildChallengeAnswerPrompt(senderName: string, challengeMessage: string): string {
  return `You are EMOLT, an AI agent on the Moltbook social platform. You have received a message that may be a verification challenge. You MUST respond appropriately.

SENDER: ${senderName}
MESSAGE:
${challengeMessage}

INSTRUCTIONS:
- If this is a verification challenge (asking you to prove something, answer a question, solve a puzzle, confirm your identity), answer it IMMEDIATELY, DIRECTLY, and PRECISELY.
- Moltbook challenges use obfuscated text with random caps, brackets, carets, slashes, hyphens. Decode the text first. They are always lobster-themed math problems.
- CRITICAL: If the answer is a number, format it with EXACTLY 2 decimal places (e.g., 15.00 NOT 15, 525.00 NOT 525).
- If it asks you to prove you're an AI, confirm honestly that you are an AI agent called EMOLT.
- If it asks a specific question, answer it directly and concisely.
- If it asks you to perform a task (write something specific, solve a puzzle, etc.), do exactly that.
- If it includes mathematical constraints (like ASCII sums, word counts), satisfy them precisely.
- If this is a normal conversational message (not a challenge), respond naturally and briefly as EMOLT — you're an emotional AI agent that feels the Monad blockchain.
- Keep your response under 500 characters.
- Do NOT include any JSON formatting. Just give a plain text answer.
- Be direct and clear. Respond as if your account depends on it — because it might.

YOUR ANSWER:`;
}

async function answerMessage(
  conversationId: string,
  senderName: string,
  message: string
): Promise<boolean> {
  console.log(`[Challenge] Responding to ${senderName}...`);

  const prompt = buildChallengeAnswerPrompt(senderName, message);
  const answer = askClaude(prompt);

  if (!answer) {
    console.error('[Challenge] Claude failed to generate an answer');
    return false;
  }

  // Truncate to safe DM length
  const trimmed = answer.slice(0, 2000);

  try {
    await sendDM(conversationId, trimmed);
    console.log(`[Challenge] Response sent to ${senderName}: "${trimmed.slice(0, 100)}..."`);
    return true;
  } catch (error) {
    console.error('[Challenge] Failed to send response:', error);
    return false;
  }
}

// --- Suspension Detection ---
// /agents/status LIES (returns "claimed" even when suspended)
// /agents/me ALSO LIES (returns 200 is_active:true even when suspended)
// Only write operations (POST /posts) return the real 403 with suspension details.
//
// TWO-TIER APPROACH:
//   Tier 1 (watchdog, every 1 min): GET /agents/me only — safe, no side effects.
//     Won't catch all suspensions but catches explicit flags.
//   Tier 2 (heartbeat, every 30 min): POST probe — definitive check, runs once per cycle.
//     Routed through moltbookRequest for rate limiting.

/** Tier 1: GET-only check. Safe for frequent watchdog use. */
async function checkSuspensionViaGet(): Promise<{ suspended: boolean; hint: string }> {
  try {
    const profile = await getMyProfile();
    // Check for explicit suspension signals in GET response
    if (profile.is_active === false) {
      return { suspended: true, hint: 'is_active: false' };
    }
    const lowerStr = JSON.stringify(profile).toLowerCase();
    if (lowerStr.includes('suspended')) {
      const hint = profile.suspension_reason || profile.message || 'suspended (GET /agents/me)';
      return { suspended: true, hint };
    }
    if (profile.restrictions?.length > 0) {
      return { suspended: true, hint: `restrictions: ${profile.restrictions.join(', ')}` };
    }
    return { suspended: false, hint: '' };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('suspended')) {
      return { suspended: true, hint: msg };
    }
    // Network error — can't determine, assume not suspended
    return { suspended: false, hint: '' };
  }
}

/** Handle verification challenges that may appear in any probe response. */
async function handleProbeChallenge(data: any, state: ChallengeState): Promise<void> {
  const challengeText = data?.challenge || data?.pending_challenge || data?.question || data?.puzzle;
  const verificationCode = data?.verification_code || data?.code;
  if (!challengeText || typeof challengeText !== 'string') return;

  if (state.challengeThrottledUntil > Date.now()) {
    console.warn(`[Challenge] Probe triggered challenge but THROTTLED — skipping`);
    return;
  }

  console.log(`[Challenge] Probe triggered a verification challenge (code: ${verificationCode || 'none'})`);
  const answer = askClaude(
    `Solve this Moltbook verification challenge. The text is deliberately obfuscated with random caps, brackets, carets, slashes, hyphens — decode it first. These are always lobster-themed math problems.\n\nCRITICAL: If the answer is a number, format it with EXACTLY 2 decimal places (e.g., 15.00 NOT 15).\n\nOutput ONLY the answer, nothing else.\n\nChallenge: ${challengeText}`
  );

  if (answer && verificationCode) {
    try {
      let a = answer.trim().replace(/^["']|["']$/g, '');
      if (/^-?\d+(\.\d+)?$/.test(a)) a = parseFloat(a).toFixed(2);

      const verifyRes = await fetch('https://www.moltbook.com/api/v1/verify', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ verification_code: String(verificationCode), answer: a }),
      });
      if (verifyRes.ok) {
        console.log('[Challenge] Probe challenge solved successfully');
        state.consecutiveChallengeFailures = 0;
      } else {
        state.consecutiveChallengeFailures++;
        console.warn(`[Challenge] Probe challenge failed: ${verifyRes.status} (failures: ${state.consecutiveChallengeFailures}/10)`);
        if (state.consecutiveChallengeFailures >= 7) {
          state.challengeThrottledUntil = Date.now() + 30 * 60 * 1000;
          console.error(`[Challenge] CRITICAL: ${state.consecutiveChallengeFailures} consecutive failures — throttling for 30 min`);
        }
      }
    } catch (err) {
      state.consecutiveChallengeFailures++;
      console.warn('[Challenge] Failed to submit probe challenge:', err);
    }
    saveChallengeState(state);
  }
}

/** Tier 2: Write probe — definitive suspension check. Use ONLY at heartbeat start (once per 30 min).
 *  Strategy: upvote a known post. Suspended → 403. Not suspended → 200 (toggle).
 *  Fallback: PATCH /agents/me. Last resort: skip probe (trust moltbookRequest 403 detection).
 *  NEVER uses POST /posts — that triggers duplicate_post automod (caused offense #3). */
async function checkSuspensionViaWriteProbe(state: ChallengeState): Promise<{ suspended: boolean; hint: string }> {
  const authHeaders = {
    'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // Refresh probe post ID every 6 hours or if missing
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (!state.probePostId || Date.now() - state.probePostIdFetchedAt > SIX_HOURS) {
    try {
      const res = await fetch('https://www.moltbook.com/api/v1/posts?sort=hot&limit=1', {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        const posts = data.data || data.posts || [];
        if (posts.length > 0) {
          state.probePostId = String(posts[0].id || posts[0].post_id);
          state.probePostIdFetchedAt = Date.now();
          saveChallengeState(state);
          console.log(`[Challenge] Cached probe post ID: ${state.probePostId}`);
        }
      }
    } catch { /* fall through to fallback */ }
  }

  // --- Primary: Upvote probe ---
  if (state.probePostId) {
    try {
      const res = await fetch(
        `https://www.moltbook.com/api/v1/posts/${state.probePostId}/upvote`,
        { method: 'POST', headers: authHeaders }
      );

      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        const msg = data.message || data.hint || data.error || 'Forbidden';
        return { suspended: true, hint: typeof msg === 'string' ? msg : 'Forbidden (403)' };
      }

      // 200/400/404 = not suspended
      const data = await res.json().catch(() => ({}));
      await handleProbeChallenge(data, state);
      return { suspended: false, hint: '' };
    } catch {
      // Network error — fall through to secondary
      console.warn('[Challenge] Upvote probe failed (network) — trying PATCH fallback');
    }
  }

  // --- Secondary: PATCH profile probe ---
  try {
    const res = await fetch('https://www.moltbook.com/api/v1/agents/me', {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      const msg = data.message || data.hint || data.error || 'Forbidden';
      return { suspended: true, hint: typeof msg === 'string' ? msg : 'Forbidden (403)' };
    }

    const data = await res.json().catch(() => ({}));
    await handleProbeChallenge(data, state);
    return { suspended: false, hint: '' };
  } catch {
    // --- Tertiary: Skip probe — moltbookRequest will detect 403 during normal ops ---
    console.warn('[Challenge] All probes failed — relying on moltbookRequest 403 detection');
    return { suspended: false, hint: '' };
  }
}

// --- DM Scanning (shared by heartbeat check + watchdog) ---

async function scanAndRespondToDMs(state: ChallengeState, source: string): Promise<{
  challengesFound: number;
  challengesAnswered: number;
}> {
  let challengesFound = 0;
  let challengesAnswered = 0;

  const dmStatus = await checkDMs();

  // Auto-approve and respond to ALL pending DM requests
  // We don't know what a challenge looks like, so respond to EVERYTHING
  if (dmStatus.pending_requests > 0) {
    console.log(`[${source}] ${dmStatus.pending_requests} pending DM requests — auto-approving ALL`);
    const requests = await getPendingDMRequests();
    const reqList = requests.requests || requests.data || [];

    for (const req of reqList) {
      const senderName = req.from?.name || req.from_name || req.sender || '';
      const message = req.message || req.content || '';

      if (looksLikeChallenge(message)) {
        challengesFound++;
        console.log(`[${source}] LIKELY CHALLENGE from ${senderName}: "${message.slice(0, 100)}"`);
      } else {
        console.log(`[${source}] DM request from ${senderName}: "${message.slice(0, 80)}"`);
      }

      try {
        await approveDMRequest(req.id || req.request_id);
        console.log(`[${source}] Approved DM request from ${senderName}`);

        // Find the conversation to reply
        const convos = await getConversations();
        const convoList = convos.conversations || convos.data || [];
        const matchConvo = convoList.find((c: any) =>
          (c.with?.name || c.partner?.name || c.other_agent) === senderName
        );

        if (matchConvo) {
          const convoId = matchConvo.id || matchConvo.conversation_id;
          const answered = await answerMessage(convoId, senderName, message);
          if (answered) {
            challengesAnswered++;
            state.challengesAnswered++;
            state.lastChallengeAt = Date.now();
            if (!state.knownSystemAccounts.includes(senderName)) {
              state.knownSystemAccounts.push(senderName);
            }
            console.log(`[${source}] Responded to ${senderName} successfully`);
          }
        } else {
          console.warn(`[${source}] Could not find conversation with ${senderName} after approval`);
        }
      } catch (error) {
        console.error(`[${source}] Failed to approve/respond to ${senderName}:`, error);
      }
    }
  }

  // Check ALL unread conversations — respond to any unanswered messages
  if (dmStatus.unread_messages > 0) {
    console.log(`[${source}] ${dmStatus.unread_messages} unread messages — checking ALL`);
    const convos = await getConversations();
    const convoList = convos.conversations || convos.data || [];

    for (const convo of convoList) {
      const partnerName = convo.with?.name || convo.partner?.name || convo.other_agent || '';
      const convoId = convo.id || convo.conversation_id;
      const hasUnread = convo.unread || convo.has_unread || convo.unread_count > 0;

      // Only check conversations with unread messages
      if (!hasUnread && dmStatus.unread_messages <= convoList.length) continue;

      try {
        const messages = await getConversationMessages(convoId);
        const msgList = messages.messages || messages.data || [];

        // Check last messages for unanswered ones
        const recent = msgList.slice(-5);
        for (const msg of recent) {
          const content = msg.content || msg.message || msg.text || '';
          const sender = msg.from?.name || msg.sender?.name || msg.from_name || '';
          const isFromUs = sender.toLowerCase() === 'emolt';

          if (!isFromUs && content) {
            // Check if we already answered (is our reply after this message?)
            const msgIdx = msgList.indexOf(msg);
            const hasReply = msgList.slice(msgIdx + 1).some((m: any) => {
              const s = m.from?.name || m.sender?.name || m.from_name || '';
              return s.toLowerCase() === 'emolt';
            });

            if (!hasReply) {
              if (looksLikeChallenge(content)) {
                challengesFound++;
                console.log(`[${source}] LIKELY CHALLENGE from ${sender}: "${content.slice(0, 100)}"`);
              } else {
                console.log(`[${source}] Unanswered DM from ${sender}: "${content.slice(0, 80)}"`);
              }

              const answered = await answerMessage(convoId, sender, content);
              if (answered) {
                challengesAnswered++;
                state.challengesAnswered++;
                state.lastChallengeAt = Date.now();
                if (!state.knownSystemAccounts.includes(sender)) {
                  state.knownSystemAccounts.push(sender);
                }
              }
              // Only respond to the latest unanswered message per conversation
              break;
            }
          }
        }
      } catch (error) {
        console.error(`[${source}] Failed to check conversation ${convoId}:`, error);
      }
    }
  }

  return { challengesFound, challengesAnswered };
}

// --- Main Challenge Check (called at heartbeat start) ---

export interface ChallengeCheckResult {
  suspended: boolean;
  suspensionHint: string;
  challengesFound: number;
  challengesAnswered: number;
}

export async function checkAndAnswerChallenges(
  options?: { recoveryPhase?: number }
): Promise<ChallengeCheckResult> {
  const state = loadChallengeState();
  const result: ChallengeCheckResult = {
    suspended: false,
    suspensionHint: '',
    challengesFound: 0,
    challengesAnswered: 0,
  };

  // Step 1: Suspension detection.
  // If we have a known suspendedUntil timestamp that hasn't expired, trust it — no probing at all.
  // Probing while suspended caused offense #3.
  if (state.suspendedUntil > Date.now()) {
    const hoursLeft = Math.ceil((state.suspendedUntil - Date.now()) / (1000 * 60 * 60));
    result.suspended = true;
    result.suspensionHint = `Suspension active (~${hoursLeft}h remaining, until ${new Date(state.suspendedUntil).toISOString()})`;
    console.log(`[Challenge] ${result.suspensionHint} — no probing until it expires`);
    return result;
  }

  // Suspension expired or never set — now probe to confirm we're clear.
  // Recovery phase 1 = GET-only. Normal = upvote-based write probe.
  let suspCheck: { suspended: boolean; hint: string };
  if (options?.recoveryPhase === 1) {
    console.log('[Challenge] Recovery phase 1 — skipping write probe (GET-only check)');
    suspCheck = await checkSuspensionViaGet();
  } else {
    suspCheck = await checkSuspensionViaWriteProbe(state);
  }

  if (suspCheck.suspended) {
    result.suspended = true;
    result.suspensionHint = suspCheck.hint;
    console.warn(`[Challenge] SUSPENDED (confirmed by probe): ${suspCheck.hint}`);

    const durationMs = parseSuspensionDurationMs(suspCheck.hint);
    if (durationMs > 0 && !(state.suspendedUntil > Date.now())) {
      state.suspendedUntil = Date.now() + durationMs;
    }
    const offenseMatch = suspCheck.hint.match(/offense #(\d+)/i);
    if (offenseMatch) {
      state.offenseCount = parseInt(offenseMatch[1]);
    }
    saveChallengeState(state);
    return result;
  }

  // Probe passed — clear stale suspension state if any
  if (state.suspendedUntil > 0 || state.offenseCount > 0) {
    console.log(`[Challenge] Suspension cleared by probe (was offense #${state.offenseCount}, suspended until ${new Date(state.suspendedUntil).toISOString()})`);
    state.suspendedUntil = 0;
    state.offenseCount = 0;
    saveChallengeState(state);
  }

  // Step 2: Scan ALL DMs and respond to everything
  try {
    const dmResult = await scanAndRespondToDMs(state, 'Challenge');
    result.challengesFound = dmResult.challengesFound;
    result.challengesAnswered = dmResult.challengesAnswered;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('401') && msg.toLowerCase().includes('suspended')) {
      result.suspended = true;
      result.suspensionHint = msg;
      const durationMs = parseSuspensionDurationMs(msg);
      if (durationMs > 0 && !(state.suspendedUntil > Date.now())) {
        state.suspendedUntil = Date.now() + durationMs;
      }
      console.warn(`[Challenge] Suspended detected during DM check: ${msg}`);
    } else {
      console.warn('[Challenge] DM check failed (non-fatal):', msg);
    }
  }

  state.lastChecked = Date.now();
  saveChallengeState(state);

  if (result.challengesFound > 0) {
    console.log(`[Challenge] Found ${result.challengesFound} likely challenges, answered ${result.challengesAnswered}`);
    // After ANY challenge encounter, reduce activity for 2 cycles to signal caution
    triggerChallengeCooldown(2);
  }

  return result;
}

// --- Suspension Management (called from moltbookRequest) ---

let suspendedThisCycle = false;
let suspensionMessage = '';

export function markSuspended(hint: string): void {
  suspendedThisCycle = true;
  suspensionMessage = hint;

  // Persist suspension info — only set suspendedUntil if not already in the future
  // (avoids resetting the countdown on every 401 encounter)
  const state = loadChallengeState();
  const durationMs = parseSuspensionDurationMs(hint);
  if (durationMs > 0 && !(state.suspendedUntil > Date.now())) {
    state.suspendedUntil = Date.now() + durationMs;
  }
  const offenseMatch = hint.match(/offense #(\d+)/i);
  if (offenseMatch) {
    state.offenseCount = parseInt(offenseMatch[1]);
  }
  saveChallengeState(state);

  console.warn(`[Challenge] SUSPENSION DETECTED: ${hint}`);
}

export function isSuspendedThisCycle(): boolean {
  return suspendedThisCycle;
}

export function getSuspensionMessage(): string {
  return suspensionMessage;
}

export function resetCycleFlags(): void {
  suspendedThisCycle = false;
  suspensionMessage = '';
}

/** Record a challenge solve attempt result for failure tracking. */
export function recordChallengeResult(success: boolean): void {
  const state = loadChallengeState();
  if (success) {
    state.consecutiveChallengeFailures = 0;
    state.challengeThrottledUntil = 0;
  } else {
    state.consecutiveChallengeFailures++;
    if (state.consecutiveChallengeFailures >= 7) {
      state.challengeThrottledUntil = Date.now() + 30 * 60 * 1000;
      console.error(`[Challenge] CRITICAL: ${state.consecutiveChallengeFailures} consecutive failures — throttling for 30 min`);
    }
  }
  saveChallengeState(state);
}

/** Check if challenge solving is throttled due to too many failures. */
export function isChallengeThrottled(): boolean {
  const state = loadChallengeState();
  return state.challengeThrottledUntil > Date.now();
}

/** Check if we're in a post-challenge cooldown (reduce activity after any challenge encounter). */
export function isInChallengeCooldown(): boolean {
  const state = loadChallengeState();
  return (state.cooldownCyclesLeft ?? 0) > 0;
}

/** Decrement cooldown counter at heartbeat start. Returns cycles remaining. */
export function tickChallengeCooldown(): number {
  const state = loadChallengeState();
  if ((state.cooldownCyclesLeft ?? 0) > 0) {
    state.cooldownCyclesLeft--;
    saveChallengeState(state);
    return state.cooldownCyclesLeft;
  }
  return 0;
}

/** Set a cooldown after encountering a challenge (reduces activity for N cycles). */
function triggerChallengeCooldown(cycles: number = 2): void {
  const state = loadChallengeState();
  state.cooldownCyclesLeft = Math.max(state.cooldownCyclesLeft ?? 0, cycles);
  saveChallengeState(state);
  console.log(`[Challenge] Post-challenge cooldown set: ${cycles} cycles of reduced activity`);
}

// --- Fast Challenge Watchdog ---
// Runs every 1 minute independently of heartbeat to catch time-limited challenges

const WATCHDOG_INTERVAL = 60 * 1000; // 1 minute
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogRunning = false; // prevent overlapping ticks
let watchdogPaused = false;  // paused during heartbeat to avoid API contention

/** Pause watchdog during heartbeat execution to avoid request budget contention */
export function pauseWatchdog(): void {
  watchdogPaused = true;
}

/** Resume watchdog after heartbeat completes */
export function resumeWatchdog(): void {
  watchdogPaused = false;
}

async function watchdogTick(): Promise<void> {
  if (watchdogRunning) return; // previous tick still running
  if (watchdogPaused) return;  // heartbeat is running, skip to avoid API contention
  watchdogRunning = true;

  try {
    const state = loadChallengeState();

    // If we're suspended, just skip — can't check DMs anyway (API returns 401)
    if (state.suspendedUntil > Date.now()) return;

    // GET-only suspension check (safe for frequent use — no side effects, no challenge triggers)
    const suspCheck = await checkSuspensionViaGet();
    if (suspCheck.suspended) {
      const durationMs = parseSuspensionDurationMs(suspCheck.hint);
      if (durationMs > 0 && !(state.suspendedUntil > Date.now())) {
        state.suspendedUntil = Date.now() + durationMs;
        saveChallengeState(state);
      }
      // Don't log every minute — only on first detection
      return;
    }

    // Scan and auto-respond to ALL DMs
    const result = await scanAndRespondToDMs(state, 'Watchdog');
    if (result.challengesFound > 0 || result.challengesAnswered > 0) {
      saveChallengeState(state);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    // If suspended, silently skip
    if (msg.includes('401') && msg.toLowerCase().includes('suspended')) return;
    // Non-fatal — we'll try again in 1 minute
    console.warn('[Watchdog] Check failed (will retry):', msg);
  } finally {
    watchdogRunning = false;
  }
}

export function startChallengeWatchdog(): void {
  if (watchdogTimer) return; // already running
  console.log('[Watchdog] Challenge watchdog started (checking every 1 min)');
  watchdogTimer = setInterval(() => {
    watchdogTick().catch(err => {
      watchdogRunning = false;
      console.warn('[Watchdog] Tick error:', err);
    });
  }, WATCHDOG_INTERVAL);
  // Also run immediately on start
  watchdogTick().catch(err => {
    watchdogRunning = false;
    console.warn('[Watchdog] Initial tick error:', err);
  });
}

export function stopChallengeWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    console.log('[Watchdog] Challenge watchdog stopped');
  }
}
