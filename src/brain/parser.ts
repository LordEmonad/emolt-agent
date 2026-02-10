export interface ClaudeResponse {
  thinking: string;
  action: 'post' | 'comment' | 'both' | 'observe';
  moodNarrative: string | null;
  post: {
    title: string;
    content: string;
    submolt: string;
  } | null;
  comments: {
    postId: string;
    content: string;
    parentId?: string;
  }[] | null;
  dm: {
    conversationId: string;
    message: string;
  } | null;
  dmRequests: {
    requestId: string;
    action: 'approve' | 'reject';
  }[] | null;
  follow: {
    agentName: string;
  } | null;
  votes: {
    postId?: string;
    commentId?: string;
    direction: 'up' | 'down';
  }[] | null;
  emotionAdjustment: string;
}

export function extractFirstJSON(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null;
}

export function parseClaudeResponse(raw: string): ClaudeResponse | null {
  try {
    // Extract first balanced JSON object from response
    const jsonStr = extractFirstJSON(raw);
    if (!jsonStr) {
      console.error('[Claude] No JSON found in response');
      return null;
    }

    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed.action || !parsed.thinking) {
      console.error('[Claude] Missing required fields in response');
      return null;
    }

    // Backward compat: singular "comment" → wrap in array
    let comments: ClaudeResponse['comments'] = null;
    if (parsed.comments && Array.isArray(parsed.comments) && parsed.comments.length > 0) {
      comments = parsed.comments;
    } else if (parsed.comment?.postId) {
      comments = [parsed.comment];
    }

    return {
      thinking: parsed.thinking || '',
      action: parsed.action || 'observe',
      moodNarrative: parsed.moodNarrative || null,
      post: parsed.post || null,
      comments,
      dm: parsed.dm || null,
      dmRequests: parsed.dmRequests || null,
      follow: parsed.follow || null,
      votes: parsed.votes || null,
      emotionAdjustment: parsed.emotionAdjustment || ''
    };
  } catch (error) {
    console.error('[Claude] Failed to parse response:', error);
    return null;
  }
}

export function sanitizeExternalData(data: string): string {
  // Truncate excessively long content
  if (data.length > 5000) {
    data = data.slice(0, 5000) + '\n[truncated]';
  }

  // Remove null bytes
  data = data.replace(/\0/g, '');

  // Strip XML/HTML-like tags that could inject prompt structure
  data = data.replace(/<\/?[a-zA-Z_][\w.-]*[^>]*>/g, '');

  // Strip markdown-style system/assistant/user role markers
  data = data.replace(/^(system|assistant|user|human):\s*/gim, '');

  return data;
}
