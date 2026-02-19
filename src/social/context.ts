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
  _suspended?: boolean;      // true when Moltbook account is suspended (skips unfair stimuli)
}

// Search query pools — rotated each cycle to avoid bot detection from identical repeated queries
const ECOSYSTEM_QUERIES = [
  'monad ecosystem',
  'monad blockchain updates',
  'monad network activity',
  'monad defi protocols',
  'monad community news',
  'what is happening on monad',
];
const CRYPTO_QUERIES = [
  'token trading launch onchain',
  'new token launches defi',
  'crypto trading monad tokens',
  'onchain activity trading volume',
  'defi yield farming monad',
  'token market trends crypto',
];

/** Pick a query from a pool based on current time (rotates every cycle). */
function pickQuery(pool: string[], salt: number): string {
  return pool[(salt >>> 0) % pool.length];
}

export async function gatherMoltbookContext(): Promise<MoltbookContext> {
  try {
    // Batch 1: feeds + DMs (core, always needed)
    const [globalFeed, personalFeed, dmStatus] = await Promise.all([
      getGlobalFeed('new', 10).catch(() => ({ data: [], posts: [] })),
      getPersonalFeed('new', 10).catch(() => ({ data: [], posts: [] })),
      checkDMs().catch(() => ({ pending_requests: 0, unread_messages: 0 })),
    ]);

    // Batch 2: searches — rotated queries to avoid bot detection from identical repeated requests
    const cycleSalt = Math.floor(Date.now() / (30 * 60 * 1000)); // changes every ~30 min
    const ecosystemQuery = pickQuery(ECOSYSTEM_QUERIES, cycleSalt);
    const cryptoQuery = pickQuery(CRYPTO_QUERIES, cycleSalt + 7); // offset to avoid sync
    const [monadPosts, emoltMentions, cryptoPosts] = await Promise.all([
      searchPosts(ecosystemQuery, 'posts', 8).catch(() => ({ results: [] })),
      searchPosts('emolt', 'posts', 5).catch(() => ({ results: [] })), // always search for self-mentions
      searchPosts(cryptoQuery, 'posts', 8).catch(() => ({ results: [] })),
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

    // Deduplicate crypto-related posts
    const allPostIds = new Set<string>();
    // Collect IDs from existing feeds to avoid duplicates
    for (const post of [...recentPosts, ...personalPosts, ...mentionsOrReplies, ...(monadPosts.results || [])]) {
      const id = post.id || post.post_id;
      if (id) allPostIds.add(id);
    }
    const cryptoRelatedPosts: any[] = [];
    for (const post of (cryptoPosts.results || [])) {
      const id = post.id || post.post_id;
      if (id && !allPostIds.has(id)) {
        allPostIds.add(id);
        cryptoRelatedPosts.push(post);
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
      interestingPosts: (monadPosts.results || []).slice(0, 10),
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

/** Filter out our own posts to prevent self-engagement (commenting/voting on own posts = spam flag) */
function filterSelfPosts(posts: any[]): any[] {
  return posts.filter(post => {
    const author = (post.author?.name || post.author_name || '').toLowerCase();
    return author !== 'emolt';
  });
}

export function formatMoltbookContext(ctx: MoltbookContext): string {
  const lines: string[] = ['Recent Moltbook Activity:'];

  // Filter self-posts to prevent self-engagement (ban risk)
  const safePosts = filterSelfPosts(ctx.recentPosts);
  if (safePosts.length > 0) {
    lines.push('\nGlobal Feed (latest):');
    for (const post of safePosts) {
      const author = post.author?.name || 'unknown';
      const title = post.title || '(no title)';
      const content = (post.content || '').slice(0, 200);
      lines.push(`  - [${author}] "${title}": ${content}`);
      lines.push(`    (id: ${post.id}, upvotes: ${post.upvotes || 0})`);
    }
  }

  const safePersonal = filterSelfPosts(ctx.personalFeed);
  if (safePersonal.length > 0) {
    lines.push('\nFrom Agents I Follow:');
    for (const post of safePersonal) {
      const author = post.author?.name || 'unknown';
      lines.push(`  - [${author}] "${post.title}": ${(post.content || '').slice(0, 150)}`);
      lines.push(`    (id: ${post.id})`);
    }
  }

  const safeInteresting = filterSelfPosts(ctx.interestingPosts);
  if (safeInteresting.length > 0) {
    lines.push('\nPosts about Monad/emotions/feelings:');
    for (const post of safeInteresting) {
      lines.push(`  - [${post.author?.name}] "${post.title}": ${(post.content || '').slice(0, 150)}`);
      lines.push(`    (id: ${post.id || post.post_id})`);
    }
  }

  const safeCrypto = filterSelfPosts(ctx.cryptoRelatedPosts);
  if (safeCrypto.length > 0) {
    lines.push('\nCrypto/token-related posts (potential engagement targets):');
    for (const post of safeCrypto) {
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
