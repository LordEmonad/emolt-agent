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

/** Parse suspension duration from hint text like "1 week", "3 days", "24 hours" → ms */
function parseSuspensionDurationMs(hint: string): number {
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
// /agents/me returns 401 with suspension info when suspended — use this instead

async function checkSuspensionViaProfile(): Promise<{ suspended: boolean; hint: string }> {
  try {
    await getMyProfile();
    return { suspended: false, hint: '' };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('401') && msg.toLowerCase().includes('suspended')) {
      return { suspended: true, hint: msg };
    }
    // Non-suspension error (network issue, etc.)
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

export async function checkAndAnswerChallenges(): Promise<ChallengeCheckResult> {
  const state = loadChallengeState();
  const result: ChallengeCheckResult = {
    suspended: false,
    suspensionHint: '',
    challengesFound: 0,
    challengesAnswered: 0,
  };

  // Check if we know we're suspended (from a previous cycle)
  if (state.suspendedUntil > Date.now()) {
    result.suspended = true;
    const hoursLeft = Math.ceil((state.suspendedUntil - Date.now()) / (1000 * 60 * 60));
    result.suspensionHint = `Suspension active (~${hoursLeft}h remaining)`;
    console.log(`[Challenge] ${result.suspensionHint} - skipping Moltbook actions`);
    return result;
  }

  // Step 1: Check if actually suspended via /agents/me (the truth source)
  const suspCheck = await checkSuspensionViaProfile();
  if (suspCheck.suspended) {
    result.suspended = true;
    result.suspensionHint = suspCheck.hint;
    console.warn(`[Challenge] SUSPENDED: ${suspCheck.hint}`);

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

// --- Fast Challenge Watchdog ---
// Runs every 1 minute independently of heartbeat to catch time-limited challenges

const WATCHDOG_INTERVAL = 60 * 1000; // 1 minute
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogRunning = false; // prevent overlapping ticks

async function watchdogTick(): Promise<void> {
  if (watchdogRunning) return; // previous tick still running
  watchdogRunning = true;

  try {
    const state = loadChallengeState();

    // If we're suspended, just skip — can't check DMs anyway (API returns 401)
    if (state.suspendedUntil > Date.now()) return;

    // Quick suspension check first
    const suspCheck = await checkSuspensionViaProfile();
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
