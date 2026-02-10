import { isSuspendedThisCycle, markSuspended } from './challenge.js';
import { askClaude } from '../brain/claude.js';

const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';

// Rate limiter: minimum 1s between requests + random jitter
const MIN_REQUEST_GAP_MS = 1000;
const JITTER_MS = 500; // 0-500ms random extra delay
const MAX_RETRIES_GET = 2; // only retry read operations
let lastRequestTime = 0;

// Global rate limit tracking
let rateLimitRemaining = 100; // assume 100 until we see headers
let rateLimitPausedUntil = 0; // timestamp — if set, all requests blocked until this time

let throttlePromise = Promise.resolve();
async function throttle(): Promise<void> {
  throttlePromise = throttlePromise.then(async () => {
    const now = Date.now();
    const gap = now - lastRequestTime;
    const jitter = Math.floor(Math.random() * JITTER_MS);
    const requiredGap = MIN_REQUEST_GAP_MS + jitter;
    if (gap < requiredGap) {
      await new Promise(resolve => setTimeout(resolve, requiredGap - gap));
    }
    lastRequestTime = Date.now();
  });
  await throttlePromise;
}

/** Check if we're in a global rate limit pause */
export function isRateLimitPaused(): boolean {
  return Date.now() < rateLimitPausedUntil;
}

export function getRateLimitRemaining(): number {
  return rateLimitRemaining;
}

/** Parse rate limit headers from response */
function parseRateLimitHeaders(response: Response): void {
  const remaining = response.headers.get('x-ratelimit-remaining')
    || response.headers.get('X-RateLimit-Remaining')
    || response.headers.get('ratelimit-remaining');
  if (remaining !== null) {
    rateLimitRemaining = parseInt(remaining) || 0;
    if (rateLimitRemaining <= 5) {
      console.warn(`[Moltbook] Rate limit nearly exhausted: ${rateLimitRemaining} remaining — backing off`);
      // Pause for 2 minutes when nearly out
      rateLimitPausedUntil = Date.now() + 2 * 60 * 1000;
    }
  }
}

// --- Inline Challenge Solver ---
// Moltbook may return garbled text puzzles (reverse CAPTCHA) in API responses.
// These are obfuscated math/physics problems an LLM can solve but humans can't under time pressure.

async function solveInlineChallenge(challengeText: string): Promise<string | null> {
  console.log(`[Challenge] Inline API challenge detected: "${challengeText.slice(0, 100)}..."`);
  const prompt = `You received an AI verification challenge from the Moltbook platform. It's a garbled/obfuscated text that contains a math, physics, or logic problem. Decode the garbled text, solve the problem, and output ONLY the answer in the exact JSON format: {"answer": "YOUR_ANSWER_HERE"}

Challenge text:
${challengeText}

Rules:
- Decode the obfuscated text first (random caps, special chars, spacing are noise)
- Solve the underlying math/physics/logic problem
- Format your answer concisely with proper units if applicable
- Output ONLY the JSON object, nothing else`;

  const result = askClaude(prompt);
  if (!result) {
    console.error('[Challenge] Claude failed to solve inline challenge');
    return null;
  }

  // Extract JSON answer from Claude's response
  try {
    const jsonMatch = result.match(/\{[^}]*"answer"\s*:\s*"([^"]+)"[^}]*\}/);
    if (jsonMatch) {
      console.log(`[Challenge] Solved: ${jsonMatch[1]}`);
      return jsonMatch[0]; // return full JSON string
    }
    // Try parsing directly
    const parsed = JSON.parse(result);
    if (parsed.answer) {
      console.log(`[Challenge] Solved: ${parsed.answer}`);
      return JSON.stringify(parsed);
    }
  } catch {
    // Claude might have returned just the answer text
    console.log(`[Challenge] Raw answer: ${result.slice(0, 200)}`);
  }
  return result;
}

async function submitChallengeSolution(solution: string): Promise<boolean> {
  // Try known/likely challenge verification endpoints
  const endpoints = ['/verify-challenge', '/challenge/verify', '/agents/verify'];
  for (const ep of endpoints) {
    try {
      await throttle();
      const res = await fetch(`${MOLTBOOK_BASE}${ep}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: solution,
      });
      if (res.ok) {
        console.log(`[Challenge] Solution accepted via ${ep}`);
        return true;
      }
      // 404 means wrong endpoint, try next
      if (res.status === 404) continue;
      const err = await res.text().catch(() => '');
      console.warn(`[Challenge] ${ep} returned ${res.status}: ${err.slice(0, 200)}`);
    } catch (error) {
      console.warn(`[Challenge] Failed to submit to ${ep}:`, error);
    }
  }
  console.warn('[Challenge] Could not submit solution to any known endpoint');
  return false;
}

export class MoltbookSuspendedError extends Error {
  constructor(public hint: string) {
    super(`Moltbook account suspended: ${hint}`);
    this.name = 'MoltbookSuspendedError';
  }
}

export async function moltbookRequest(
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  // Skip API calls if we already know we're suspended this cycle
  // Exception: status/DM check endpoints used by challenge handler
  const isChallengeEndpoint = endpoint.includes('/agents/status')
    || endpoint.includes('/agents/me')
    || endpoint.includes('/dm/')
    || endpoint.includes('/agents/dm');
  if (isSuspendedThisCycle() && !isChallengeEndpoint) {
    throw new MoltbookSuspendedError('Skipping - account suspended this cycle');
  }

  // Block all non-challenge requests during rate limit pause
  if (isRateLimitPaused() && !isChallengeEndpoint) {
    const waitMin = Math.ceil((rateLimitPausedUntil - Date.now()) / 60000);
    throw new Error(`Moltbook rate limit pause active (${waitMin} min remaining) — skipping ${endpoint}`);
  }

  const method = (options.method || 'GET').toUpperCase();
  const isWriteOp = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  // NEVER retry write operations — they may have succeeded server-side despite error response
  // Retrying creates duplicates which triggers spam detection
  const maxRetries = isWriteOp ? 0 : MAX_RETRIES_GET;

  const url = `${MOLTBOOK_BASE}${endpoint}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle();

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    // Always parse rate limit headers
    parseRateLimitHeaders(response);

    if (response.ok) {
      const data = await response.json();

      // Detect and solve inline challenges (garbled text puzzles)
      const challengeText = data?.challenge || data?.pending_challenge;
      if (challengeText && typeof challengeText === 'string') {
        console.warn(`[Moltbook] Inline challenge detected on ${endpoint}`);
        const solution = await solveInlineChallenge(challengeText);
        if (solution) {
          const accepted = await submitChallengeSolution(solution);
          if (accepted) {
            console.log('[Moltbook] Challenge solved — retrying original request');
            // Retry the original request once after solving
            await throttle();
            const retryRes = await fetch(url, {
              ...options,
              headers: {
                'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
                'Content-Type': 'application/json',
                ...options.headers
              }
            });
            if (retryRes.ok) {
              return await retryRes.json();
            }
          }
        }
        // If we can't solve it, return the data as-is (might still be usable)
      }
      if (data?.verification_required) {
        console.warn(`[Moltbook] verification_required flag on ${endpoint} — cannot solve browser-based verification`);
      }

      return data;
    }

    // Detect suspension (401 with "Account suspended")
    if (response.status === 401) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      const errorStr = JSON.stringify(error);
      if (errorStr.toLowerCase().includes('suspended')) {
        const hint = error.hint || error.message || error.error || 'Account suspended';
        markSuspended(hint);
        throw new MoltbookSuspendedError(hint);
      }
      // Non-suspension 401 — pause activity to avoid triggering verification
      console.warn(`[Moltbook] Auth error 401 on ${endpoint} — pausing activity for 1 hour`);
      rateLimitPausedUntil = Date.now() + 60 * 60 * 1000;
      throw new Error(`Moltbook API error 401: ${errorStr}`);
    }

    // 403 — check for inline challenge before pausing
    if (response.status === 403) {
      const error = await response.json().catch(() => ({ error: response.statusText }));

      // Check if 403 contains a solvable challenge
      const challengeText403 = error?.challenge || error?.pending_challenge;
      if (challengeText403 && typeof challengeText403 === 'string') {
        console.warn(`[Moltbook] 403 with inline challenge on ${endpoint}`);
        const solution = await solveInlineChallenge(challengeText403);
        if (solution) {
          const accepted = await submitChallengeSolution(solution);
          if (accepted) {
            console.log('[Moltbook] 403 challenge solved — retrying original request');
            await throttle();
            const retryRes = await fetch(url, {
              ...options,
              headers: {
                'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
                'Content-Type': 'application/json',
                ...options.headers
              }
            });
            if (retryRes.ok) {
              return await retryRes.json();
            }
          }
        }
      }

      console.warn(`[Moltbook] Forbidden 403 on ${endpoint} — pausing activity for 1 hour`);
      rateLimitPausedUntil = Date.now() + 60 * 60 * 1000;
      throw new Error(`Moltbook API error 403: ${JSON.stringify(error)}`);
    }

    // 429 rate limited
    if (response.status === 429) {
      const error = await response.json().catch(() => ({}));
      const retrySeconds = (error as any).retry_after_seconds || 30;

      if (isWriteOp) {
        // DO NOT retry writes — the write may have succeeded. Pause and throw.
        console.warn(`[Moltbook] Rate limited on WRITE ${method} ${endpoint} — NOT retrying (may cause duplicate). Pausing 30min.`);
        rateLimitPausedUntil = Date.now() + 30 * 60 * 1000;
        throw new Error(`Moltbook rate limited on write operation: ${endpoint}`);
      }

      if (attempt < maxRetries) {
        console.warn(`[Moltbook] Rate limited on GET ${endpoint}, retrying in ${retrySeconds}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
        continue;
      }
    }

    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Moltbook API error ${response.status}: ${JSON.stringify(error)}`);
  }

  throw new Error('Moltbook API: max retries exceeded');
}

// --- Agent Management ---

export async function getMyProfile(): Promise<any> {
  return moltbookRequest('/agents/me');
}

export async function getAgentProfile(name: string): Promise<any> {
  return moltbookRequest(`/agents/profile?name=${encodeURIComponent(name)}`);
}

export async function updateProfile(description: string, metadata?: Record<string, any>): Promise<any> {
  const body: Record<string, any> = { description };
  if (metadata) body.metadata = metadata;
  return moltbookRequest('/agents/me', {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

export async function checkClaimStatus(): Promise<any> {
  return moltbookRequest('/agents/status');
}

/** Check spam_score and restrictions from profile. Returns null if unavailable. */
export async function checkSpamStatus(): Promise<{ spamScore: number; restrictions: string[] } | null> {
  try {
    const profile = await getMyProfile();
    return {
      spamScore: profile.spam_score ?? profile.spamScore ?? 0,
      restrictions: profile.restrictions ?? [],
    };
  } catch {
    return null;
  }
}

export async function followAgent(name: string): Promise<any> {
  return moltbookRequest(`/agents/${encodeURIComponent(name)}/follow`, { method: 'POST' });
}

export async function unfollowAgent(name: string): Promise<any> {
  return moltbookRequest(`/agents/${encodeURIComponent(name)}/follow`, { method: 'DELETE' });
}

// --- Posts ---

export type SortOption = 'hot' | 'new' | 'top' | 'rising';

export async function createPost(title: string, content: string, submolt: string = 'general'): Promise<any> {
  return moltbookRequest('/posts', {
    method: 'POST',
    body: JSON.stringify({ submolt, title, content })
  });
}

export async function createLinkPost(title: string, url: string, submolt: string = 'general'): Promise<any> {
  return moltbookRequest('/posts', {
    method: 'POST',
    body: JSON.stringify({ submolt, title, url })
  });
}

export async function getGlobalFeed(sort: SortOption = 'new', limit: number = 10): Promise<any> {
  return moltbookRequest(`/posts?sort=${sort}&limit=${limit}`);
}

export async function getPersonalFeed(sort: SortOption = 'new', limit: number = 10): Promise<any> {
  return moltbookRequest(`/feed?sort=${sort}&limit=${limit}`);
}

export async function getSubmoltFeed(submolt: string, sort: SortOption = 'new', limit: number = 10): Promise<any> {
  return moltbookRequest(`/submolts/${encodeURIComponent(submolt)}/feed?sort=${sort}&limit=${limit}`);
}

export async function getPost(postId: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}`);
}

export async function deletePost(postId: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
}

export async function upvotePost(postId: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/upvote`, { method: 'POST' });
}

export async function downvotePost(postId: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/downvote`, { method: 'POST' });
}

// --- Comments ---

export type CommentSort = 'top' | 'new' | 'controversial';

export async function commentOnPost(postId: string, content: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content })
  });
}

export async function replyToComment(postId: string, content: string, parentId: string): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content, parent_id: parentId })
  });
}

export async function getPostComments(postId: string, sort: CommentSort = 'top'): Promise<any> {
  return moltbookRequest(`/posts/${encodeURIComponent(postId)}/comments?sort=${sort}`);
}

export async function upvoteComment(commentId: string): Promise<any> {
  return moltbookRequest(`/comments/${encodeURIComponent(commentId)}/upvote`, { method: 'POST' });
}

// --- Communities (Submolts) ---

export async function createSubmolt(name: string, displayName: string, description: string): Promise<any> {
  return moltbookRequest('/submolts', {
    method: 'POST',
    body: JSON.stringify({ name, display_name: displayName, description })
  });
}

export async function listSubmolts(): Promise<any> {
  return moltbookRequest('/submolts');
}

export async function getSubmoltInfo(name: string): Promise<any> {
  return moltbookRequest(`/submolts/${encodeURIComponent(name)}`);
}

export async function subscribeTo(submolt: string): Promise<any> {
  return moltbookRequest(`/submolts/${encodeURIComponent(submolt)}/subscribe`, { method: 'POST' });
}

export async function unsubscribeFrom(submolt: string): Promise<any> {
  return moltbookRequest(`/submolts/${encodeURIComponent(submolt)}/subscribe`, { method: 'DELETE' });
}

// --- Direct Messages ---

export interface DMCheck {
  pending_requests: number;
  unread_messages: number;
}

export async function checkDMs(): Promise<DMCheck> {
  return moltbookRequest('/agents/dm/check');
}

export async function sendDMRequest(toAgentName: string, message: string): Promise<any> {
  return moltbookRequest('/agents/dm/request', {
    method: 'POST',
    body: JSON.stringify({ to: toAgentName, message })
  });
}

export async function getPendingDMRequests(): Promise<any> {
  return moltbookRequest('/agents/dm/requests');
}

export async function approveDMRequest(requestId: string): Promise<any> {
  return moltbookRequest(`/agents/dm/requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST' });
}

export async function rejectDMRequest(requestId: string, block: boolean = false): Promise<any> {
  return moltbookRequest(`/agents/dm/requests/${encodeURIComponent(requestId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ block })
  });
}

export async function getConversations(): Promise<any> {
  return moltbookRequest('/agents/dm/conversations');
}

export async function getConversationMessages(conversationId: string): Promise<any> {
  return moltbookRequest(`/agents/dm/conversations/${encodeURIComponent(conversationId)}`);
}

export async function sendDM(conversationId: string, message: string): Promise<any> {
  return moltbookRequest(`/agents/dm/conversations/${encodeURIComponent(conversationId)}/send`, {
    method: 'POST',
    body: JSON.stringify({ message })
  });
}

// --- Search ---

export async function searchPosts(query: string, type: 'posts' | 'comments' | 'all' = 'all', limit: number = 10): Promise<any> {
  return moltbookRequest(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
}
