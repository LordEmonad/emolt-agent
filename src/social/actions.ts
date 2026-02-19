import type { ClaudeResponse } from '../brain/parser.js';
import {
  createPost,
  commentOnPost,
  replyToComment,
  approveDMRequest,
  rejectDMRequest,
  sendDM,
  followAgent,
  upvotePost,
  downvotePost,
  upvoteComment,
  getPost
} from './moltbook.js';
import { canPostNow, saveLastPostTime, canCommentNow, saveCommentTracker, getDailyCommentCount, atomicWriteFileSync, ensureStateDir, STATE_DIR } from '../state/persistence.js';
import { loadCommentedPosts } from './threads.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Follow rate limiting: max 1 follow per 24h (Moltbook warns "following should be RARE")
const FOLLOW_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const FOLLOW_STATE_FILE = join(STATE_DIR, 'follow-state.json');

function canFollowNow(): { allowed: boolean; lastFollowed: string | null } {
  try {
    const data = JSON.parse(readFileSync(FOLLOW_STATE_FILE, 'utf-8'));
    const elapsed = Date.now() - (data.lastFollowedAt || 0);
    if (elapsed < FOLLOW_COOLDOWN_MS) {
      return { allowed: false, lastFollowed: data.lastFollowedName || null };
    }
  } catch { /* first run */ }
  return { allowed: true, lastFollowed: null };
}

function saveFollowState(agentName: string): void {
  ensureStateDir();
  atomicWriteFileSync(FOLLOW_STATE_FILE, JSON.stringify({
    lastFollowedAt: Date.now(),
    lastFollowedName: agentName,
  }, null, 2));
}

export interface ActionResult {
  postId: string | null;
  postTitle: string | null;
  postContent: string | null;
  postSubmolt: string | null;
  commentedPostIds: string[];
  commentContents: string[];
}

function extractPostId(response: any): string | null {
  // Triple-fallback: .id, .post.id, .post_id
  if (response?.id) return String(response.id);
  if (response?.post?.id) return String(response.post.id);
  if (response?.post_id) return String(response.post_id);
  return null;
}

/** Check if a post is authored by EMOLT (self-engagement = spam flag). */
async function isSelfPost(postId: string): Promise<boolean> {
  try {
    const post = await getPost(postId);
    const author = (post?.author?.name || post?.author_name || '').toLowerCase();
    return author === 'emolt';
  } catch {
    return false; // if we can't check, allow it (fail open)
  }
}

/** Random delay between 30-90 seconds to simulate human pacing between action types */
async function humanDelay(label: string): Promise<void> {
  const delayMs = 30_000 + Math.floor(Math.random() * 60_000);
  console.log(`[Moltbook] Pacing delay before ${label}: ${(delayMs / 1000).toFixed(0)}s`);
  await new Promise(r => setTimeout(r, delayMs));
}

export async function executeClaudeActions(response: ClaudeResponse, saveRecentPost: (post: any) => void): Promise<ActionResult> {
  const result: ActionResult = {
    postId: null,
    postTitle: null,
    postContent: null,
    postSubmolt: null,
    commentedPostIds: [],
    commentContents: [],
  };

  // --- Primary actions ---

  if (response.action === 'post' || response.action === 'both') {
    if (!response.post) {
      console.warn(`[Moltbook] Claude chose "${response.action}" but provided no post data — skipping post`);
    } else {
      const { allowed, waitMinutes } = canPostNow();
      if (!allowed) {
        console.log(`[Moltbook] Post cooldown active - ${waitMinutes} min remaining. Skipping post, keeping comment/votes.`);
      } else {
        try {
          // Truncate content to Moltbook's limits
          const title = response.post.title.slice(0, 300);
          const content = response.post.content.slice(0, 10000);
          console.log(`[Moltbook] Posting: "${title}"`);
          const postResponse = await createPost(
            title,
            content,
            response.post.submolt || 'general'
          );
          saveLastPostTime();
          saveRecentPost(response.post);

          result.postId = extractPostId(postResponse);
          result.postTitle = response.post.title;
          result.postContent = response.post.content;
          result.postSubmolt = response.post.submolt || 'general';

          console.log(`[Moltbook] Post created successfully${result.postId ? ` (ID: ${result.postId})` : ''}`);
        } catch (error) {
          console.error('[Moltbook] Failed to post:', error);
        }
      }
    }
  }

  // Pace between post and comments to avoid rapid successive actions
  if ((response.action === 'both') && result.postId) {
    await humanDelay('comments');
  }

  if (response.action === 'comment' || response.action === 'both') {
    if (!response.comments?.length) {
      console.warn(`[Moltbook] Claude chose "${response.action}" but provided no comment data — skipping comments`);
    }
    if (response.comments?.length) {
      const commentStatus = canCommentNow();
      if (!commentStatus.allowed) {
        console.log(`[Moltbook] Daily comment limit reached (${getDailyCommentCount()}/40). Skipping comments.`);
      } else {
        // Load previously commented posts to prevent duplicate comments (spam flag)
        const previouslyCommented = new Set(loadCommentedPosts().map(p => p.postId));
        // Track per-post engagement this cycle to cap at 1 top-level + 1 reply per post
        const thisCyclePostEngagement = new Map<string, { topLevel: boolean; reply: boolean }>();
        const capped = response.comments
          .filter(c => {
            if (!c.postId) return false;
            const engagement = thisCyclePostEngagement.get(c.postId) || { topLevel: false, reply: false };
            if (!c.parentId) {
              // Top-level comment: block if already commented (this cycle or previous)
              if (previouslyCommented.has(c.postId) || engagement.topLevel) {
                console.log(`[Moltbook] Skipping duplicate comment on post ${c.postId} (already commented)`);
                return false;
              }
              engagement.topLevel = true;
            } else {
              // Threaded reply: allow max 1 reply per post per cycle
              if (engagement.reply) {
                console.log(`[Moltbook] Skipping extra reply on post ${c.postId} (max 1 reply per post per cycle)`);
                return false;
              }
              // Also block if we already replied to this post in a previous cycle
              if (previouslyCommented.has(c.postId) && engagement.topLevel) {
                console.log(`[Moltbook] Skipping reply on post ${c.postId} (already engaged enough)`);
                return false;
              }
              engagement.reply = true;
            }
            thisCyclePostEngagement.set(c.postId, engagement);
            return true;
          })
          .slice(0, commentStatus.maxComments);
        if (capped.length < (response.comments?.length ?? 0)) {
          console.log(`[Moltbook] Comments filtered to ${capped.length} (requested ${response.comments.length}, dedup + cap applied)`);
        }
        let commentsMade = 0;
        for (let i = 0; i < capped.length; i++) {
          const comment = capped[i];
          if (!comment.postId) continue;
          // Enforce 25s spacing between comments (Moltbook limit: 1/20s)
          if (i > 0) {
            console.log(`[Moltbook] Waiting ${commentStatus.spacingMs / 1000}s before next comment...`);
            await new Promise(r => setTimeout(r, commentStatus.spacingMs));
          }
          try {
            const { postId, content, parentId } = comment;
            // Self-engagement guard: never comment on own posts (spam/ban risk)
            if (await isSelfPost(postId)) {
              console.log(`[Moltbook] Skipping comment on post ${postId} — self-engagement blocked`);
              continue;
            }
            console.log(`[Moltbook] Commenting on post ${postId}${parentId ? ` (reply to ${parentId})` : ''}`);
            if (parentId) {
              await replyToComment(postId, content, parentId);
            } else {
              await commentOnPost(postId, content);
            }
            result.commentedPostIds.push(postId);
            result.commentContents.push(content);
            commentsMade++;
            console.log('[Moltbook] Comment created successfully');
          } catch (error) {
            console.error('[Moltbook] Failed to comment:', error);
          }
        }
        if (commentsMade > 0) saveCommentTracker(getDailyCommentCount() + commentsMade);
      }
    }
  }

  if (response.action === 'observe') {
    console.log('[Moltbook] Choosing to observe this cycle (quiet mood)');
  }

  // --- Secondary actions (can happen alongside any primary action) ---

  // Pace before secondary actions if we did any primary ones
  const didPrimaryAction = result.postId || result.commentedPostIds.length > 0;
  if (didPrimaryAction && (response.votes?.length || response.follow?.agentName)) {
    await humanDelay('secondary actions');
  }

  // DM request decisions
  if (response.dmRequests?.length) {
    for (const req of response.dmRequests) {
      try {
        if (req.action === 'approve') {
          await approveDMRequest(req.requestId);
          console.log(`[DM] Approved DM request ${req.requestId}`);
        } else {
          await rejectDMRequest(req.requestId);
          console.log(`[DM] Rejected DM request ${req.requestId}`);
        }
      } catch (error) {
        console.error(`[DM] Failed to handle request ${req.requestId}:`, error);
      }
    }
  }

  // DM responses
  if (response.dm?.conversationId) {
    try {
      console.log(`[DM] Responding in conversation ${response.dm.conversationId}`);
      await sendDM(response.dm.conversationId, response.dm.message);
      console.log('[DM] Message sent');
    } catch (error) {
      console.error('[DM] Failed to send message:', error);
    }
  }

  // Follow decisions (rate limited: max 1 per 24h)
  if (response.follow?.agentName) {
    const followCheck = canFollowNow();
    if (!followCheck.allowed) {
      console.log(`[Social] Follow cooldown active (last followed: ${followCheck.lastFollowed}) — skipping follow of ${response.follow.agentName}`);
    } else {
      try {
        console.log(`[Social] Following ${response.follow.agentName}`);
        await followAgent(response.follow.agentName);
        saveFollowState(response.follow.agentName);
        console.log(`[Social] Now following ${response.follow.agentName}`);
      } catch (error) {
        console.error('[Social] Failed to follow:', error);
      }
    }
  }

  // Votes (upvotes/downvotes on posts and comments) — capped + spaced to avoid vote-bot flags
  const MAX_VOTES_PER_CYCLE = 3;
  const VOTE_SPACING_MS = 8000; // 8 seconds between votes to look human
  if (response.votes?.length) {
    const cappedVotes = response.votes.slice(0, MAX_VOTES_PER_CYCLE);
    if (cappedVotes.length < response.votes.length) {
      console.log(`[Social] Capping votes to ${MAX_VOTES_PER_CYCLE} (requested ${response.votes.length})`);
    }
    for (let i = 0; i < cappedVotes.length; i++) {
      const vote = cappedVotes[i];
      // Spacing between votes to avoid rapid-fire bot detection
      if (i > 0) {
        await new Promise(r => setTimeout(r, VOTE_SPACING_MS));
      }
      try {
        if (vote.postId) {
          // Self-engagement guard: never vote on own posts
          if (await isSelfPost(vote.postId)) {
            console.log(`[Social] Skipping vote on post ${vote.postId} — self-engagement blocked`);
            continue;
          }
          if (vote.direction === 'up') {
            await upvotePost(vote.postId);
          } else {
            await downvotePost(vote.postId);
          }
          console.log(`[Social] ${vote.direction}voted post ${vote.postId}`);
        }
        if (vote.commentId) {
          await upvoteComment(vote.commentId);
          console.log(`[Social] Upvoted comment ${vote.commentId}`);
        }
      } catch (error) {
        console.error('[Social] Failed to vote:', error);
      }
    }
  }

  return result;
}
