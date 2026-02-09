import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { askClaude } from '../brain/claude.js';
import { extractFirstJSON, sanitizeExternalData } from '../brain/parser.js';
import { buildChatPrompt, ChatMessage } from './prompt.js';
import { ensureStateDir, STATE_DIR } from '../state/persistence.js';

const PORT = parseInt(process.env.CHAT_PORT || '3777', 10);
const CHATS_DIR = join(STATE_DIR, 'chats');
const CHAT_HTML = join(process.cwd(), 'chat.html');

// --- Session management ---

function ensureChatsDir(): void {
  ensureStateDir();
  if (!existsSync(CHATS_DIR)) {
    mkdirSync(CHATS_DIR, { recursive: true });
  }
}

function makeSessionId(): string {
  // e.g. "2026-02-09_01-15-42"
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '').replace('T', '_');
}

function sessionFilePath(id: string): string {
  return join(CHATS_DIR, `chat-${id}.jsonl`);
}

// Current session
let sessionId = makeSessionId();
let sessionMessages: ChatMessage[] = [];

function currentSessionFile(): string {
  return sessionFilePath(sessionId);
}

// --- Chat log persistence ---

interface ChatLogEntry {
  user: string;
  emolt: string;
  thinking: string;
  emotionalNuance: string;
  timestamp: string;
  durationMs: number;
}

function appendToSession(entry: ChatLogEntry): void {
  ensureChatsDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(currentSessionFile(), line, 'utf-8');
}

function loadSessionEntries(id: string): ChatLogEntry[] {
  try {
    const file = sessionFilePath(id);
    return readFileSync(file, 'utf-8')
      .trimEnd().split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

interface SessionInfo {
  id: string;
  file: string;
  startedAt: string;
  entries: number;
  preview: string;
}

function listSessions(): SessionInfo[] {
  ensureChatsDir();
  try {
    const files = readdirSync(CHATS_DIR)
      .filter(f => f.startsWith('chat-') && f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first

    return files.map(f => {
      const id = f.replace(/^chat-/, '').replace(/\.jsonl$/, '');
      const fullPath = join(CHATS_DIR, f);
      let entries = 0;
      let preview = '';
      try {
        const content = readFileSync(fullPath, 'utf-8').trimEnd();
        const lines = content.split('\n').filter(l => l.trim());
        entries = lines.length;
        if (lines.length > 0) {
          const first = JSON.parse(lines[0]);
          preview = first.user?.slice(0, 60) || '';
        }
      } catch { /* empty file */ }

      // Parse the timestamp back from the ID
      const startedAt = id.replace('_', 'T').replace(/-/g, (m, offset) => {
        // First 10 chars are date (keep hyphens), rest are time (convert back to colons)
        return offset >= 10 ? ':' : '-';
      }) + 'Z';

      return { id, file: f, startedAt, entries, preview };
    });
  } catch {
    return [];
  }
}

// --- Response parsing ---

interface ChatResponse {
  thinking: string;
  response: string;
  emotionalNuance: string;
}

function parseChatResponse(raw: string): ChatResponse | null {
  const jsonStr = extractFirstJSON(raw);
  if (!jsonStr) {
    if (raw.trim()) {
      return { thinking: '(no structured thinking)', response: raw.trim(), emotionalNuance: '(none)' };
    }
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      thinking: parsed.thinking || '',
      response: parsed.response || '',
      emotionalNuance: parsed.emotionalNuance || '',
    };
  } catch {
    return null;
  }
}

// --- HTTP helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  url.slice(idx + 1).split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return params;
}

// --- Handlers ---

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let userMessage: string;

  try {
    const parsed = JSON.parse(body);
    userMessage = parsed.message;
    if (!userMessage || typeof userMessage !== 'string') {
      json(res, 400, { error: 'missing "message" field' });
      return;
    }
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const sanitized = sanitizeExternalData(userMessage);
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] [Chat] [${sessionId}] User: ${sanitized.slice(0, 100)}${sanitized.length > 100 ? '...' : ''}`);

  const prompt = buildChatPrompt(sessionMessages, sanitized);
  const start = Date.now();
  const raw = askClaude(prompt);
  const durationMs = Date.now() - start;

  if (!raw) {
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }

  const chatResp = parseChatResponse(raw);
  if (!chatResp) {
    json(res, 500, { error: 'failed to parse claude response' });
    return;
  }

  console.log(`[${timestamp}] [Chat] [${sessionId}] EMOLT (${durationMs}ms): ${chatResp.response.slice(0, 100)}${chatResp.response.length > 100 ? '...' : ''}`);

  // Add to session history
  sessionMessages.push(
    { role: 'user', content: sanitized, timestamp },
    { role: 'emolt', content: chatResp.response, thinking: chatResp.thinking, emotionalNuance: chatResp.emotionalNuance, timestamp: new Date().toISOString() }
  );

  // Keep session manageable (last 40 messages = 20 exchanges)
  if (sessionMessages.length > 40) {
    sessionMessages = sessionMessages.slice(-40);
  }

  // Persist to session file
  appendToSession({
    user: sanitized,
    emolt: chatResp.response,
    thinking: chatResp.thinking,
    emotionalNuance: chatResp.emotionalNuance,
    timestamp,
    durationMs,
  });

  // Load current emotion state for the UI
  let emotionState = null;
  try {
    const data = readFileSync(join(STATE_DIR, 'emotion-state.json'), 'utf-8');
    emotionState = JSON.parse(data);
  } catch { /* no state yet */ }

  json(res, 200, {
    response: chatResp.response,
    thinking: chatResp.thinking,
    emotionalNuance: chatResp.emotionalNuance,
    emotionState,
    durationMs,
    sessionId,
  });
}

function handleSessions(_req: IncomingMessage, res: ServerResponse): void {
  const sessions = listSessions();
  json(res, 200, { sessions, currentSession: sessionId });
}

function handleHistory(req: IncomingMessage, res: ServerResponse): void {
  const query = parseQuery(req.url || '');
  const id = query.session || sessionId;
  const entries = loadSessionEntries(id);
  json(res, 200, { session: id, entries, isCurrent: id === sessionId });
}

function handleNewSession(_req: IncomingMessage, res: ServerResponse): void {
  const oldId = sessionId;
  sessionId = makeSessionId();
  sessionMessages = [];
  console.log(`[${new Date().toISOString()}] [Chat] New session: ${sessionId} (was ${oldId})`);
  json(res, 200, { sessionId, previousSession: oldId });
}

function serveHTML(res: ServerResponse): void {
  try {
    const html = readFileSync(CHAT_HTML, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('chat.html not found - run from project root');
  }
}

// --- Server ---

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = (req.url || '').split('?')[0];

  try {
    if (url === '/' && req.method === 'GET') {
      serveHTML(res);
    } else if (url === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res);
    } else if (url === '/api/sessions' && req.method === 'GET') {
      handleSessions(req, res);
    } else if (url === '/api/history' && req.method === 'GET') {
      handleHistory(req, res);
    } else if (url === '/api/new' && req.method === 'POST') {
      handleNewSession(req, res);
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    console.error('[Chat] Request error:', err);
    json(res, 500, { error: 'internal server error' });
  }
});

ensureChatsDir();

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  EMOLT Chat Server                      ║
  ║  http://localhost:${PORT}                  ║
  ║                                          ║
  ║  Session: ${sessionId}       ║
  ║  Logs: state/chats/                      ║
  ╚══════════════════════════════════════════╝
  `);
});
