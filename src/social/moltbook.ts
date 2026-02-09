import { isSuspendedThisCycle, markSuspended } from './challenge.js';

const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';

// Rate limiter: minimum 200ms between requests, max 2 retries on 429
const MIN_REQUEST_GAP_MS = 200;
const MAX_RETRIES = 2;
let lastRequestTime = 0;

let throttlePromise = Promise.resolve();
async function throttle(): Promise<void> {
  // Chain requests to ensure sequential timing even with concurrent callers
  throttlePromise = throttlePromise.then(async () => {
    const now = Date.now();
    const gap = now - lastRequestTime;
    if (gap < MIN_REQUEST_GAP_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_GAP_MS - gap));
    }
    lastRequestTime = Date.now();
  });
  await throttlePromise;
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
    || endpoint.includes('/dm/')
    || endpoint.includes('/agents/dm');
  if (isSuspendedThisCycle() && !isChallengeEndpoint) {
    throw new MoltbookSuspendedError('Skipping - account suspended this cycle');
  }

  const url = `${MOLTBOOK_BASE}${endpoint}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (response.ok) {
      const data = await response.json();

      // Inspect response for challenge fields (undocumented - defensive check)
      if (data?.challenge || data?.verification_required || data?.pending_challenge) {
        console.warn(`[Moltbook] Response contains challenge field on ${endpoint}: ${JSON.stringify(data.challenge || data.pending_challenge || 'verification_required')}`);
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
      throw new Error(`Moltbook API error 401: ${errorStr}`);
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const error = await response.json().catch(() => ({}));
      const retrySeconds = (error as any).retry_after_seconds || 5;
      console.warn(`[Moltbook] Rate limited, retrying in ${retrySeconds}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
      continue;
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
