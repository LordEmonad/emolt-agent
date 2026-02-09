import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR } from '../state/persistence.js';
import { getPostComments } from './moltbook.js';

const COMMENTED_POSTS_FILE = join(STATE_DIR, 'commented-posts.json');
const MAX_TRACKED_POSTS = 20;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export interface CommentedPost {
  postId: string;
  commentContent: string;
  authorName: string | null;
  timestamp: number;
  postTitle?: string;
  postContent?: string;
}

export interface ThreadReply {
  postId: string;
  replyAuthor: string;
  replyContent: string;
  replyId: string;
  ourComment: string;
}

export function loadCommentedPosts(): CommentedPost[] {
  try {
    const data = readFileSync(COMMENTED_POSTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveCommentedPosts(posts: CommentedPost[]): void {
  ensureStateDir();
  atomicWriteFileSync(COMMENTED_POSTS_FILE, JSON.stringify(posts, null, 2));
}

export function trackComment(
  postId: string,
  commentContent: string,
  authorName: string | null,
  postTitle?: string,
  postContent?: string
): void {
  const posts = loadCommentedPosts();

  // Deduplicate by postId - update existing
  const existing = posts.find(p => p.postId === postId);
  if (existing) {
    existing.commentContent = commentContent.slice(0, 500);
    existing.timestamp = Date.now();
    if (postTitle) existing.postTitle = postTitle;
    if (postContent) existing.postContent = postContent.slice(0, 500);
  } else {
    posts.push({
      postId,
      commentContent: commentContent.slice(0, 500),
      authorName,
      timestamp: Date.now(),
      postTitle,
      postContent: postContent?.slice(0, 500),
    });
  }

  // Keep only last MAX_TRACKED_POSTS
  const trimmed = posts.slice(-MAX_TRACKED_POSTS);
  saveCommentedPosts(trimmed);
}

export async function checkForThreadReplies(): Promise<ThreadReply[]> {
  const posts = loadCommentedPosts();
  const now = Date.now();
  const replies: ThreadReply[] = [];

  // Filter to posts from last 24 hours, limit API calls
  const recentPosts = posts
    .filter(p => now - p.timestamp < TWENTY_FOUR_HOURS)
    .slice(-10);

  for (const tracked of recentPosts) {
    try {
      const response = await getPostComments(tracked.postId, 'new');
      const comments = response.comments || response.data || [];

      for (const comment of comments) {
        // Skip our own comments (heuristic: posted after our timestamp and not by us)
        const commentTime = comment.created_at
          ? new Date(comment.created_at).getTime()
          : 0;

        if (commentTime <= tracked.timestamp) continue;

        const author = comment.author?.name || comment.author_name;
        if (!author) continue;

        // Heuristic: skip if it looks like our own (content matches)
        const content = comment.content || '';
        if (content === tracked.commentContent) continue;

        replies.push({
          postId: tracked.postId,
          replyAuthor: author,
          replyContent: content.slice(0, 300),
          replyId: comment.id || comment.comment_id || '',
          ourComment: tracked.commentContent,
        });
      }
    } catch {
      // Individual post fetch failure - skip silently
    }
  }

  return replies;
}

export function formatThreadContext(replies: ThreadReply[]): string {
  if (replies.length === 0) return '';

  const lines: string[] = ['## Active Conversations (someone replied to you)\n'];

  for (const reply of replies.slice(0, 8)) {
    lines.push(`- **You said:** "${reply.ourComment}"`);
    lines.push(`  **${reply.replyAuthor} replied:** "${reply.replyContent}"`);
    lines.push(`  _(postId: ${reply.postId}, parentId: ${reply.replyId} for threaded reply)_`);
    lines.push('');
  }

  return lines.join('\n');
}
