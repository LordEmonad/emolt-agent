import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureStateDir, atomicWriteFileSync, STATE_DIR, savePostPerformance, loadPostPerformance } from '../state/persistence.js';
import { getPost } from './moltbook.js';

// --- Types ---

export interface TrackedPost {
  postId: string;
  title: string;
  content: string;
  submolt: string;
  cycle: number;
  createdAt: number;
  lastChecked: number;
}

export interface TrackedPostWithPerformance extends TrackedPost {
  upvotes: number;
  downvotes: number;
  comments: number;
  score: number;
}

// --- Persistence ---

const TRACKED_POSTS_FILE = join(STATE_DIR, 'tracked-posts.json');
const MAX_TRACKED = 20;

export function loadTrackedPosts(): TrackedPost[] {
  try {
    const data = readFileSync(TRACKED_POSTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveTrackedPosts(posts: TrackedPost[]): void {
  ensureStateDir();
  atomicWriteFileSync(TRACKED_POSTS_FILE, JSON.stringify(posts, null, 2));
}

// --- Tracking ---

export function trackNewPost(
  postId: string,
  title: string,
  content: string,
  submolt: string,
  cycle: number
): void {
  const posts = loadTrackedPosts();

  // Don't double-track
  if (posts.some(p => p.postId === postId)) return;

  posts.push({
    postId,
    title,
    content,
    submolt,
    cycle,
    createdAt: Date.now(),
    lastChecked: 0,
  });

  // Trim to max capacity - keep newest
  const trimmed = posts.slice(-MAX_TRACKED);
  saveTrackedPosts(trimmed);

  console.log(`[Feedback] Tracking post ${postId}: "${title}"`);
}

// --- Engagement Refresh ---

export async function refreshPostEngagement(): Promise<TrackedPostWithPerformance[]> {
  const posts = loadTrackedPosts();
  if (posts.length === 0) return [];

  const now = Date.now();
  const results: TrackedPostWithPerformance[] = [];

  // Load persisted performance so stale posts keep last-known engagement
  const perfMap = new Map<string, any>();
  for (const p of loadPostPerformance()) perfMap.set(p.postId, p);

  for (const post of posts) {
    // Only fetch posts between 10min and 48h old
    const ageMs = now - post.createdAt;
    if (ageMs < 10 * 60 * 1000 || ageMs > 48 * 60 * 60 * 1000) {
      const prev = perfMap.get(post.postId);
      results.push({
        ...post,
        upvotes: prev?.upvotes ?? 0,
        downvotes: prev?.downvotes ?? 0,
        comments: prev?.comments ?? 0,
        score: prev?.score ?? 0,
      });
      continue;
    }

    try {
      const data = await getPost(post.postId);
      const enriched: TrackedPostWithPerformance = {
        ...post,
        lastChecked: now,
        upvotes: data.upvotes ?? data.up_votes ?? 0,
        downvotes: data.downvotes ?? data.down_votes ?? 0,
        comments: data.comment_count ?? data.comments?.length ?? 0,
        score: data.score ?? (data.upvotes ?? 0) - (data.downvotes ?? 0),
      };
      results.push(enriched);
    } catch (error) {
      console.warn(`[Feedback] Failed to fetch post ${post.postId}:`, error);
      const prev = perfMap.get(post.postId);
      results.push({
        ...post,
        upvotes: prev?.upvotes ?? 0,
        downvotes: prev?.downvotes ?? 0,
        comments: prev?.comments ?? 0,
        score: prev?.score ?? 0,
      });
    }
  }

  // Update lastChecked timestamps
  const updated = posts.map(p => {
    const result = results.find(r => r.postId === p.postId);
    return result ? { ...p, lastChecked: result.lastChecked } : p;
  });
  saveTrackedPosts(updated);

  return results;
}

// --- Feedback Report ---

function performanceLabel(upvotes: number, comments: number): string {
  const engagement = upvotes + comments * 2;
  if (engagement >= 20) return '[strong]';
  if (engagement >= 8) return '[decent]';
  if (engagement >= 3) return '[modest]';
  if (engagement > 0) return '[quiet]';
  return '[silent]';
}

export function buildFeedbackReport(posts: TrackedPostWithPerformance[]): string {
  const active = posts.filter(p => p.lastChecked > 0 && (p.upvotes > 0 || p.comments > 0 || p.score !== 0));

  if (active.length === 0 && posts.length === 0) {
    return '## Post Feedback\nNo posts tracked yet.';
  }

  if (active.length === 0) {
    return '## Post Feedback\nYour tracked posts have no engagement data yet - too new or too old to check.';
  }

  const lines: string[] = ['## Post Feedback (How Your Posts Performed)\n'];

  // Per-post stats
  for (const post of active) {
    const age = Math.round((Date.now() - post.createdAt) / (1000 * 60 * 60));
    const ageStr = age < 1 ? '<1h ago' : `${age}h ago`;
    const label = performanceLabel(post.upvotes, post.comments);
    lines.push(`- "${post.title}" (${ageStr}): ${post.upvotes} upvotes, ${post.comments} comments ${label}`);
  }

  // Averages
  const avgUpvotes = active.reduce((s, p) => s + p.upvotes, 0) / active.length;
  const avgComments = active.reduce((s, p) => s + p.comments, 0) / active.length;
  lines.push('');
  lines.push(`Average: ${avgUpvotes.toFixed(1)} upvotes, ${avgComments.toFixed(1)} comments per post`);

  // Best and worst
  const sorted = [...active].sort((a, b) => (b.upvotes + b.comments * 2) - (a.upvotes + a.comments * 2));
  if (sorted.length >= 2) {
    lines.push(`Best: "${sorted[0].title}" (${sorted[0].upvotes} upvotes)`);
    lines.push(`Weakest: "${sorted[sorted.length - 1].title}" (${sorted[sorted.length - 1].upvotes} upvotes)`);
  }

  return lines.join('\n');
}

// --- Compat: Sync to post-performance.json ---

export function syncToPostPerformance(posts: TrackedPostWithPerformance[]): void {
  const active = posts.filter(p => p.lastChecked > 0);
  if (active.length === 0) return;

  const existing = loadPostPerformance();

  for (const post of active) {
    const existingIdx = existing.findIndex((e: any) => e.postId === post.postId);
    const entry = {
      postId: post.postId,
      title: post.title,
      upvotes: post.upvotes,
      downvotes: post.downvotes,
      comments: post.comments,
      score: post.score,
      timestamp: post.createdAt,
    };

    if (existingIdx >= 0) {
      existing[existingIdx] = entry;
    } else {
      existing.push(entry);
    }
  }

  // Keep last 30 entries
  const trimmed = existing.slice(-30);
  savePostPerformance(trimmed);

  console.log(`[Feedback] Synced ${active.length} posts to post-performance.json (${trimmed.length} total)`);
}
