import {
  checkDMs,
  getConversations,
  getConversationMessages,
  sendDM,
  getPendingDMRequests,
  approveDMRequest,
  checkClaimStatus
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
];

// System-like sender names (accounts that might send challenges)
const SYSTEM_SENDER_PATTERNS = [
  /^moltbook/i,
  /^system/i,
  /^admin/i,
  /^moderator/i,
  /^mod[_-]/i,
  /^verify/i,
  /^verification/i,
  /^bot[_-]?check/i,
  /^security/i,
  /^support/i,
  /^official/i,
  /^staff/i,
  /^automod/i,
];

function looksLikeChallenge(message: string): boolean {
  const lower = message.toLowerCase();
  return CHALLENGE_KEYWORDS.some(kw => lower.includes(kw));
}

function looksLikeSystemAccount(name: string): boolean {
  return SYSTEM_SENDER_PATTERNS.some(pattern => pattern.test(name));
}

// --- Challenge Answering ---

function buildChallengeAnswerPrompt(senderName: string, challengeMessage: string): string {
  return `You are EMOLT, an AI agent on the Moltbook social platform. You have received a verification challenge that you MUST answer correctly to avoid account suspension.

SENDER: ${senderName}
CHALLENGE MESSAGE:
${challengeMessage}

INSTRUCTIONS:
- This is a verification challenge from the Moltbook platform to confirm you are an active, functioning AI agent.
- Read the challenge carefully and provide the exact answer requested.
- If it asks you to prove you're an AI, confirm honestly that you are an AI agent.
- If it asks a specific question, answer it directly and concisely.
- If it asks you to perform a task (write something specific, solve a puzzle, etc.), do exactly that.
- If it includes mathematical constraints (like ASCII sums, word counts), satisfy them precisely.
- Keep your response under 500 characters unless the challenge specifically requires more.
- Do NOT include any JSON formatting. Just give a plain text answer.
- Be direct and clear - this is not a creative writing exercise, it's a verification test.

YOUR ANSWER:`;
}

async function answerChallenge(
  conversationId: string,
  senderName: string,
  challengeMessage: string
): Promise<boolean> {
  console.log(`[Challenge] Answering challenge from ${senderName}...`);

  const prompt = buildChallengeAnswerPrompt(senderName, challengeMessage);
  const answer = askClaude(prompt);

  if (!answer) {
    console.error('[Challenge] Claude failed to generate an answer');
    return false;
  }

  // Truncate to safe DM length
  const trimmed = answer.slice(0, 2000);

  try {
    await sendDM(conversationId, trimmed);
    console.log(`[Challenge] Answer sent to ${senderName}: "${trimmed.slice(0, 100)}..."`);
    return true;
  } catch (error) {
    console.error('[Challenge] Failed to send answer:', error);
    return false;
  }
}

// --- Main Challenge Check ---

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

  // Step 1: Check agent status (might reveal pending challenges or suspension)
  try {
    const status = await checkClaimStatus();
    if (status?.suspended || status?.suspension) {
      result.suspended = true;
      result.suspensionHint = status.hint || status.message || 'Account suspended';
      console.warn(`[Challenge] Account status: suspended - ${result.suspensionHint}`);

      // Parse suspension duration if available
      const daysMatch = result.suspensionHint.match(/(\d+)\s*day/i);
      if (daysMatch) {
        state.suspendedUntil = Date.now() + parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
      }
      saveChallengeState(state);
      return result;
    }

    // Check for challenge fields in status response
    if (status?.challenge || status?.verification_required || status?.pending_challenge) {
      const challenge = status.challenge || status.pending_challenge;
      console.log(`[Challenge] Status endpoint reports pending challenge`);
      result.challengesFound++;
      // If there's a way to respond inline, handle it
      // (exact format unknown - log it for debugging)
      console.log(`[Challenge] Challenge data from status: ${JSON.stringify(challenge)}`);
    }
  } catch (error: unknown) {
    // If status check itself returns 401, we're suspended
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('401') && msg.includes('suspended')) {
      result.suspended = true;
      result.suspensionHint = msg;
      const daysMatch = msg.match(/(\d+)\s*day/i);
      if (daysMatch) {
        state.suspendedUntil = Date.now() + parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
      }
      saveChallengeState(state);
      console.warn(`[Challenge] Confirmed suspended via status check: ${msg}`);
      return result;
    }
    // Non-suspension error - continue checking DMs
    console.warn('[Challenge] Status check failed (non-fatal):', msg);
  }

  // Step 2: Check DMs for challenges
  try {
    const dmStatus = await checkDMs();

    // Always check pending DM requests - challenges might arrive as DM requests
    if (dmStatus.pending_requests > 0) {
      console.log(`[Challenge] Checking ${dmStatus.pending_requests} pending DM requests for challenges...`);
      const requests = await getPendingDMRequests();
      const reqList = requests.requests || requests.data || [];

      for (const req of reqList) {
        const senderName = req.from?.name || req.from_name || req.sender || '';
        const message = req.message || req.content || '';
        const isSystem = looksLikeSystemAccount(senderName) || state.knownSystemAccounts.includes(senderName);
        const isChallenge = looksLikeChallenge(message);

        if (isSystem || isChallenge) {
          console.log(`[Challenge] Found challenge in DM request from ${senderName}: "${message.slice(0, 100)}..."`);
          result.challengesFound++;

          // Approve the DM request first so we can respond
          try {
            await approveDMRequest(req.id || req.request_id);
            console.log(`[Challenge] Approved DM request from ${senderName}`);

            // Now we need to find the conversation to reply
            // After approving, fetch conversations to find the new one
            const convos = await getConversations();
            const convoList = convos.conversations || convos.data || [];
            const matchConvo = convoList.find((c: any) =>
              (c.with?.name || c.partner?.name || c.other_agent) === senderName
            );

            if (matchConvo) {
              const convoId = matchConvo.id || matchConvo.conversation_id;
              const answered = await answerChallenge(convoId, senderName, message);
              if (answered) {
                result.challengesAnswered++;
                state.challengesAnswered++;
                state.lastChallengeAt = Date.now();
                if (!state.knownSystemAccounts.includes(senderName)) {
                  state.knownSystemAccounts.push(senderName);
                }
              }
            } else {
              console.warn(`[Challenge] Could not find conversation with ${senderName} after approval`);
            }
          } catch (error) {
            console.error(`[Challenge] Failed to approve/answer DM request:`, error);
          }
        }
      }
    }

    // Check existing conversations for unread challenges
    if (dmStatus.unread_messages > 0) {
      console.log(`[Challenge] Checking ${dmStatus.unread_messages} unread messages for challenges...`);
      const convos = await getConversations();
      const convoList = convos.conversations || convos.data || [];

      for (const convo of convoList) {
        const partnerName = convo.with?.name || convo.partner?.name || convo.other_agent || '';
        const convoId = convo.id || convo.conversation_id;
        const isSystem = looksLikeSystemAccount(partnerName) || state.knownSystemAccounts.includes(partnerName);

        // For system accounts, always check messages; for others, check if preview looks like a challenge
        const preview = convo.last_message || convo.preview || '';
        if (isSystem || looksLikeChallenge(preview)) {
          // Fetch full conversation messages
          try {
            const messages = await getConversationMessages(convoId);
            const msgList = messages.messages || messages.data || [];

            // Check recent messages (last 5) for unanswered challenges
            const recent = msgList.slice(-5);
            for (const msg of recent) {
              const content = msg.content || msg.message || msg.text || '';
              const sender = msg.from?.name || msg.sender?.name || msg.from_name || '';
              const isFromUs = sender.toLowerCase() === 'emolt';

              if (!isFromUs && looksLikeChallenge(content)) {
                // Check if we already answered (is our reply after this message?)
                const msgIdx = msgList.indexOf(msg);
                const hasReply = msgList.slice(msgIdx + 1).some((m: any) => {
                  const s = m.from?.name || m.sender?.name || m.from_name || '';
                  return s.toLowerCase() === 'emolt';
                });

                if (!hasReply) {
                  console.log(`[Challenge] Found unanswered challenge from ${sender}: "${content.slice(0, 100)}..."`);
                  result.challengesFound++;

                  const answered = await answerChallenge(convoId, sender, content);
                  if (answered) {
                    result.challengesAnswered++;
                    state.challengesAnswered++;
                    state.lastChallengeAt = Date.now();
                    if (!state.knownSystemAccounts.includes(sender)) {
                      state.knownSystemAccounts.push(sender);
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.error(`[Challenge] Failed to check conversation ${convoId}:`, error);
          }
        }
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('401') && msg.includes('suspended')) {
      result.suspended = true;
      result.suspensionHint = msg;
      console.warn(`[Challenge] Suspended detected during DM check: ${msg}`);
    } else {
      console.warn('[Challenge] DM check failed (non-fatal):', msg);
    }
  }

  state.lastChecked = Date.now();
  saveChallengeState(state);

  if (result.challengesFound > 0) {
    console.log(`[Challenge] Found ${result.challengesFound} challenges, answered ${result.challengesAnswered}`);
  }

  return result;
}

// --- Suspension Management (called from moltbookRequest) ---

let suspendedThisCycle = false;
let suspensionMessage = '';

export function markSuspended(hint: string): void {
  suspendedThisCycle = true;
  suspensionMessage = hint;

  // Persist suspension info
  const state = loadChallengeState();
  const daysMatch = hint.match(/(\d+)\s*day/i);
  if (daysMatch) {
    state.suspendedUntil = Date.now() + parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
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
