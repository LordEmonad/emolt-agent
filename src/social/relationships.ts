import type { ClaudeResponse } from '../brain/parser.js';
import type { MoltbookContext } from './context.js';
import type { AgentMemory, RelationshipEntry } from '../state/memory.js';
import { addMemoryEntry, updateMemoryEntry } from '../state/memory.js';

export interface InteractionRecord {
  agentName: string;
  type: 'comment' | 'dm' | 'follow' | 'upvote' | 'downvote' | 'dm_reject';
  context: string;
}

function getSentiment(type: InteractionRecord['type']): 'positive' | 'neutral' | 'negative' {
  switch (type) {
    case 'comment':
    case 'upvote':
    case 'follow':
      return 'positive';
    case 'downvote':
    case 'dm_reject':
      return 'negative';
    case 'dm':
      return 'neutral';
  }
}

export function findPostAuthor(postId: string, ctx: MoltbookContext): string | null {
  const post = findPost(postId, ctx);
  return post ? (post.author?.name || post.author_name || null) : null;
}

export function findPost(postId: string, ctx: MoltbookContext): any | null {
  const allPosts = [
    ...ctx.recentPosts,
    ...ctx.personalFeed,
    ...ctx.interestingPosts,
    ...ctx.cryptoRelatedPosts,
    ...ctx.mentionsOrReplies,
  ];
  for (const post of allPosts) {
    const id = post.id || post.post_id;
    if (id === postId) return post;
  }
  return null;
}

export function extractInteractions(response: ClaudeResponse, ctx: MoltbookContext): InteractionRecord[] {
  const interactions: InteractionRecord[] = [];

  // Comment → find post author
  if ((response.action === 'comment' || response.action === 'both') && response.comment?.postId) {
    const author = findPostAuthor(response.comment.postId, ctx);
    if (author) {
      interactions.push({
        agentName: author,
        type: 'comment',
        context: `Commented on their post ${response.comment.postId}`,
      });
    }
  }

  // Votes → find post author
  if (response.votes?.length) {
    for (const vote of response.votes) {
      if (vote.postId) {
        const author = findPostAuthor(vote.postId, ctx);
        if (author) {
          interactions.push({
            agentName: author,
            type: vote.direction === 'up' ? 'upvote' : 'downvote',
            context: `${vote.direction}voted their post ${vote.postId}`,
          });
        }
      }
    }
  }

  // Follow
  if (response.follow?.agentName) {
    interactions.push({
      agentName: response.follow.agentName,
      type: 'follow',
      context: `Followed ${response.follow.agentName}`,
    });
  }

  // DM response
  if (response.dm?.conversationId) {
    // Try to find the conversation partner
    for (const convo of ctx.dmConversations) {
      if (convo.id === response.dm.conversationId) {
        const partner = convo.with?.name || convo.partner_name;
        if (partner) {
          interactions.push({
            agentName: partner,
            type: 'dm',
            context: `DM conversation with ${partner}`,
          });
        }
        break;
      }
    }
  }

  // DM requests (approve/reject)
  if (response.dmRequests?.length) {
    for (const req of response.dmRequests) {
      // Find requester from pendingDMRequests
      for (const pendingReq of ctx.pendingDMRequests) {
        if (pendingReq.id === req.requestId) {
          const requester = pendingReq.from?.name || pendingReq.from_name;
          if (requester) {
            interactions.push({
              agentName: requester,
              type: req.action === 'approve' ? 'dm' : 'dm_reject',
              context: `${req.action === 'approve' ? 'Approved' : 'Rejected'} DM request from ${requester}`,
            });
          }
          break;
        }
      }
    }
  }

  return interactions;
}

export function updateRelationship(memory: AgentMemory, interaction: InteractionRecord): void {
  // Find existing relationship entry
  const existing = memory.entries.find(
    e => e.category === 'relationships' && 'agentName' in e && (e as RelationshipEntry).agentName === interaction.agentName
  ) as RelationshipEntry | undefined;

  const sentiment = getSentiment(interaction.type);

  if (existing) {
    existing.interactionCount++;
    existing.lastRelevantAt = Date.now();
    // Sentiment: only shift if the new sentiment has appeared consistently
    // Don't flip on a single interaction - require pattern
    if (sentiment !== existing.sentiment && sentiment !== 'neutral') {
      if (existing.interactionCount >= 5) {
        existing.sentiment = sentiment;
      }
    }
    existing.content = interaction.context;
    updateMemoryEntry(memory, existing.id, {
      content: `Last: ${interaction.context}`,
    });
  } else {
    addMemoryEntry(memory, 'relationships', interaction.context, 5, {
      agentName: interaction.agentName,
      sentiment,
      interactionCount: 1,
    } as Partial<RelationshipEntry>);
  }
}

export function trackInteractions(
  response: ClaudeResponse,
  ctx: MoltbookContext,
  memory: AgentMemory
): number {
  const interactions = extractInteractions(response, ctx);
  for (const interaction of interactions) {
    updateRelationship(memory, interaction);
  }
  if (interactions.length > 0) {
    console.log(`[Relationships] Updated ${interactions.length} interaction(s)`);
  }
  return interactions.length;
}
