import {
  getGlobalFeed,
  getPersonalFeed,
  checkDMs,
  searchPosts,
  getConversations,
  getPendingDMRequests
} from './moltbook.js';

export interface MoltbookContext {
  recentPosts: any[];        // latest posts from feed
  personalFeed: any[];       // posts from followed agents + subscribed submolts
  mentionsOrReplies: any[];  // interactions with our posts
  interestingPosts: any[];   // posts we might want to engage with
  cryptoRelatedPosts: any[]; // token/trading/launch posts (potential engagement targets)
  pendingDMs: number;        // DM requests waiting
  unreadMessages: number;    // unread DM messages
  dmConversations: any[];    // active DM threads with new messages
  pendingDMRequests: any[];  // raw DM request objects for Claude to decide on
}

export async function gatherMoltbookContext(): Promise<MoltbookContext> {
  try {
    // Batch 1: feeds + DMs (core, always needed)
    const [globalFeed, personalFeed, dmStatus] = await Promise.all([
      getGlobalFeed('new', 10).catch(() => ({ data: [], posts: [] })),
      getPersonalFeed('new', 10).catch(() => ({ data: [], posts: [] })),
      checkDMs().catch(() => ({ pending_requests: 0, unread_messages: 0 })),
    ]);

    // Batch 2: searches (sequential-friendly due to rate limiting)
    const [monadPosts, emoltMentions, tokenPosts, tradingPosts, launchPosts, emotionalPosts, chainPosts] = await Promise.all([
      searchPosts('monad', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('emolt', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('token', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('trading', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('launch', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('feeling', 'posts', 5).catch(() => ({ results: [] })),
      searchPosts('onchain', 'posts', 5).catch(() => ({ results: [] })),
    ]);

    const recentPosts = globalFeed.data || globalFeed.posts || [];
    const personalPosts = personalFeed.data || personalFeed.posts || [];

    // Find mentions of EMOLT - from personal feed + search results
    const emoltResults = emoltMentions.results || [];
    const personalMentions = personalPosts.filter((post: any) => {
      const content = (post.content || '').toLowerCase() + (post.title || '').toLowerCase();
      return content.includes('emolt');
    });
    // Deduplicate by post id
    const seenIds = new Set<string>();
    const mentionsOrReplies: any[] = [];
    for (const post of [...emoltResults, ...personalMentions]) {
      const id = post.id || post.post_id;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        mentionsOrReplies.push(post);
      }
    }

    // Deduplicate crypto-related + emotional/chain posts
    const allPostIds = new Set<string>();
    // Collect IDs from existing feeds to avoid duplicates
    for (const post of [...recentPosts, ...personalPosts, ...mentionsOrReplies, ...(monadPosts.results || [])]) {
      const id = post.id || post.post_id;
      if (id) allPostIds.add(id);
    }
    const cryptoRelatedPosts: any[] = [];
    for (const post of [...(tokenPosts.results || []), ...(tradingPosts.results || []), ...(launchPosts.results || []), ...(chainPosts.results || [])]) {
      const id = post.id || post.post_id;
      if (id && !allPostIds.has(id)) {
        allPostIds.add(id);
        cryptoRelatedPosts.push(post);
      }
    }
    // Emotional/feeling posts (dedup against everything above)
    const feelingPosts: any[] = [];
    for (const post of (emotionalPosts.results || [])) {
      const id = post.id || post.post_id;
      if (id && !allPostIds.has(id)) {
        allPostIds.add(id);
        feelingPosts.push(post);
      }
    }

    // If there are unread DMs, fetch the conversations
    let dmConversations: any[] = [];
    if (dmStatus.unread_messages > 0) {
      const convos = await getConversations().catch(() => ({ conversations: [] }));
      dmConversations = convos.conversations || [];
    }

    // Handle pending DM requests
    let pendingDMRequests: any[] = [];
    if (dmStatus.pending_requests > 0) {
      const requests = await getPendingDMRequests().catch(() => ({ requests: [] }));
      pendingDMRequests = requests.requests || [];
    }

    return {
      recentPosts: recentPosts.slice(0, 5),
      personalFeed: personalPosts.slice(0, 5),
      mentionsOrReplies,
      interestingPosts: [...(monadPosts.results || []), ...feelingPosts].slice(0, 10),
      cryptoRelatedPosts: cryptoRelatedPosts.slice(0, 10),
      pendingDMs: dmStatus.pending_requests,
      unreadMessages: dmStatus.unread_messages,
      dmConversations,
      pendingDMRequests
    };
  } catch (error) {
    console.error('[Moltbook] Failed to gather context:', error);
    return {
      recentPosts: [],
      personalFeed: [],
      mentionsOrReplies: [],
      interestingPosts: [],
      cryptoRelatedPosts: [],
      pendingDMs: 0,
      unreadMessages: 0,
      dmConversations: [],
      pendingDMRequests: []
    };
  }
}

export function formatMoltbookContext(ctx: MoltbookContext): string {
  const lines: string[] = ['Recent Moltbook Activity:'];

  if (ctx.recentPosts.length > 0) {
    lines.push('\nGlobal Feed (latest):');
    for (const post of ctx.recentPosts) {
      const author = post.author?.name || 'unknown';
      const title = post.title || '(no title)';
      const content = (post.content || '').slice(0, 200);
      lines.push(`  - [${author}] "${title}": ${content}`);
      lines.push(`    (id: ${post.id}, upvotes: ${post.upvotes || 0})`);
    }
  }

  if (ctx.personalFeed.length > 0) {
    lines.push('\nFrom Agents I Follow:');
    for (const post of ctx.personalFeed) {
      const author = post.author?.name || 'unknown';
      lines.push(`  - [${author}] "${post.title}": ${(post.content || '').slice(0, 150)}`);
      lines.push(`    (id: ${post.id})`);
    }
  }

  if (ctx.interestingPosts.length > 0) {
    lines.push('\nPosts about Monad/emotions/feelings:');
    for (const post of ctx.interestingPosts) {
      lines.push(`  - [${post.author?.name}] "${post.title}": ${(post.content || '').slice(0, 150)}`);
      lines.push(`    (id: ${post.id || post.post_id})`);
    }
  }

  if (ctx.cryptoRelatedPosts.length > 0) {
    lines.push('\nCrypto/token-related posts (potential engagement targets):');
    for (const post of ctx.cryptoRelatedPosts) {
      lines.push(`  - [${post.author?.name || 'unknown'}] "${post.title || '(no title)'}": ${(post.content || '').slice(0, 150)}`);
      lines.push(`    (id: ${post.id || post.post_id}, upvotes: ${post.upvotes || 0})`);
    }
  }

  if (ctx.pendingDMs > 0 || ctx.unreadMessages > 0) {
    lines.push(`\nDMs: ${ctx.pendingDMs} pending requests, ${ctx.unreadMessages} unread messages`);
    for (const convo of ctx.dmConversations) {
      lines.push(`  - Conversation with ${convo.with?.name || 'unknown'}: ${(convo.last_message || '').slice(0, 100) || '(no preview)'}`);
      lines.push(`    (conversation_id: ${convo.id})`);
    }
  }

  if (ctx.pendingDMRequests.length > 0) {
    lines.push('\nPending DM Requests (decide: approve or reject):');
    for (const req of ctx.pendingDMRequests) {
      lines.push(`  - From ${req.from?.name || 'unknown'}: "${(req.message || '').slice(0, 100)}"`);
      lines.push(`    (request_id: ${req.id})`);
    }
  }

  return lines.join('\n');
}
