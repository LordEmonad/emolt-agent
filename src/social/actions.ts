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
  upvoteComment
} from './moltbook.js';
import { canPostNow, saveLastPostTime } from '../state/persistence.js';

export interface ActionResult {
  postId: string | null;
  postTitle: string | null;
  postContent: string | null;
  postSubmolt: string | null;
  commentedPostId: string | null;
  commentContent: string | null;
}

function extractPostId(response: any): string | null {
  // Triple-fallback: .id, .post.id, .post_id
  if (response?.id) return String(response.id);
  if (response?.post?.id) return String(response.post.id);
  if (response?.post_id) return String(response.post_id);
  return null;
}

export async function executeClaudeActions(response: ClaudeResponse, saveRecentPost: (post: any) => void): Promise<ActionResult> {
  const result: ActionResult = {
    postId: null,
    postTitle: null,
    postContent: null,
    postSubmolt: null,
    commentedPostId: null,
    commentContent: null,
  };

  // --- Primary actions ---

  if (response.action === 'post' || response.action === 'both') {
    if (response.post) {
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

  if (response.action === 'comment' || response.action === 'both') {
    if (response.comment?.postId) {
      try {
        const { postId, content, parentId } = response.comment;
        console.log(`[Moltbook] Commenting on post ${postId}${parentId ? ` (reply to ${parentId})` : ''}`);
        if (parentId) {
          await replyToComment(postId, content, parentId);
        } else {
          await commentOnPost(postId, content);
        }
        result.commentedPostId = postId;
        result.commentContent = content;
        console.log('[Moltbook] Comment created successfully');
      } catch (error) {
        console.error('[Moltbook] Failed to comment:', error);
      }
    }
  }

  if (response.action === 'observe') {
    console.log('[Moltbook] Choosing to observe this cycle (quiet mood)');
  }

  // --- Secondary actions (can happen alongside any primary action) ---

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

  // Follow decisions
  if (response.follow?.agentName) {
    try {
      console.log(`[Social] Following ${response.follow.agentName}`);
      await followAgent(response.follow.agentName);
      console.log(`[Social] Now following ${response.follow.agentName}`);
    } catch (error) {
      console.error('[Social] Failed to follow:', error);
    }
  }

  // Votes (upvotes/downvotes on posts and comments)
  if (response.votes?.length) {
    for (const vote of response.votes) {
      try {
        if (vote.postId) {
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
