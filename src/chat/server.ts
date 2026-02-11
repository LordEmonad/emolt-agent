import 'dotenv/config';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { askClaudeAsync } from '../brain/claude.js';
import { extractFirstJSON, sanitizeExternalData } from '../brain/parser.js';
import { buildChatPrompt, ChatMessage } from './prompt.js';
import { ensureStateDir, STATE_DIR } from '../state/persistence.js';
import { buildDispatchPrompt } from './dispatch-prompt.js';
import { buildDevPrompt, DevMessage } from './dev-prompt.js';
import { listActivities } from '../activities/registry.js';
import {
  createPlan, approvePlan, cancelPlan, killDispatch,
  getDispatch, getCurrentDispatch, getDispatchLog, listDispatches,
} from '../activities/runner.js';

// Register activities
import '../activities/clawmate.js';
import '../activities/reef.js';

const PORT = parseInt(process.env.CHAT_PORT || '3777', 10);
const CHATS_DIR = join(STATE_DIR, 'chats');
const CHAT_HTML = join(process.cwd(), 'chat.html');

// --- Session management (per-tab) ---

function ensureChatsDir(): void {
  ensureStateDir();
  if (!existsSync(CHATS_DIR)) {
    mkdirSync(CHATS_DIR, { recursive: true });
  }
}

function makeSessionId(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '').replace('T', '_');
}

function sessionFilePath(id: string): string {
  return join(CHATS_DIR, `chat-${id}.jsonl`);
}

interface TabSession {
  sessionId: string;
  messages: ChatMessage[];
  devMessages: DevMessage[];
}

const chatSessions = new Map<string, TabSession>();
const chatAborts = new Map<string, AbortController>();

function getOrCreateSession(tabId: string): TabSession {
  let session = chatSessions.get(tabId);
  if (!session) {
    session = { sessionId: makeSessionId(), messages: [], devMessages: [] };
    chatSessions.set(tabId, session);
  }
  return session;
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

function appendToSession(sessionId: string, entry: ChatLogEntry): void {
  ensureChatsDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(sessionFilePath(sessionId), line, 'utf-8');
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
      .reverse();

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

      const startedAt = id.replace('_', 'T').replace(/-/g, (m, offset: number) => {
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
  let tabId: string;

  try {
    const parsed = JSON.parse(body);
    userMessage = parsed.message;
    tabId = parsed.tabId || 'default';
    if (!userMessage || typeof userMessage !== 'string') {
      json(res, 400, { error: 'missing "message" field' });
      return;
    }
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const session = getOrCreateSession(tabId);
  const sanitized = sanitizeExternalData(userMessage);
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] [Chat] [${session.sessionId}] User: ${sanitized.slice(0, 100)}${sanitized.length > 100 ? '...' : ''}`);

  const prompt = buildChatPrompt(session.messages, sanitized);
  const start = Date.now();

  // Create abort controller for this chat request
  const ac = new AbortController();
  chatAborts.set(tabId, ac);

  let raw: string;
  try {
    raw = await askClaudeAsync(prompt, ac.signal);
  } catch (err: unknown) {
    chatAborts.delete(tabId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      json(res, 200, { aborted: true });
      return;
    }
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }
  chatAborts.delete(tabId);

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

  console.log(`[${timestamp}] [Chat] [${session.sessionId}] EMOLT (${durationMs}ms): ${chatResp.response.slice(0, 100)}${chatResp.response.length > 100 ? '...' : ''}`);

  session.messages.push(
    { role: 'user', content: sanitized, timestamp },
    { role: 'emolt', content: chatResp.response, thinking: chatResp.thinking, emotionalNuance: chatResp.emotionalNuance, timestamp: new Date().toISOString() }
  );

  if (session.messages.length > 40) {
    session.messages = session.messages.slice(-40);
  }

  appendToSession(session.sessionId, {
    user: sanitized,
    emolt: chatResp.response,
    thinking: chatResp.thinking,
    emotionalNuance: chatResp.emotionalNuance,
    timestamp,
    durationMs,
  });

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
    sessionId: session.sessionId,
  });
}

async function handleDevChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let userMessage: string;
  let tabId: string;

  try {
    const parsed = JSON.parse(body);
    userMessage = parsed.message;
    tabId = parsed.tabId || 'default';
    if (!userMessage || typeof userMessage !== 'string') {
      json(res, 400, { error: 'missing "message" field' });
      return;
    }
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const session = getOrCreateSession(tabId);
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] [Dev] [${session.sessionId}] Dev: ${userMessage.slice(0, 100)}${userMessage.length > 100 ? '...' : ''}`);

  const prompt = buildDevPrompt(session.devMessages, userMessage);
  const start = Date.now();

  const ac = new AbortController();
  chatAborts.set(tabId, ac);

  let raw: string;
  try {
    raw = await askClaudeAsync(prompt, ac.signal);
  } catch (err: unknown) {
    chatAborts.delete(tabId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      json(res, 200, { aborted: true });
      return;
    }
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }
  chatAborts.delete(tabId);

  const durationMs = Date.now() - start;

  if (!raw) {
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }

  const jsonStr = extractFirstJSON(raw);
  let response = '';
  let thinking = '';
  let context = '';

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      response = parsed.response || '';
      thinking = parsed.thinking || '';
      context = parsed.context || '';
    } catch {
      response = raw.trim();
    }
  } else {
    response = raw.trim();
  }

  console.log(`[${timestamp}] [Dev] [${session.sessionId}] Response (${durationMs}ms): ${response.slice(0, 100)}${response.length > 100 ? '...' : ''}`);

  session.devMessages.push(
    { role: 'user', content: userMessage, timestamp },
    { role: 'emolt', content: response, timestamp: new Date().toISOString() }
  );

  if (session.devMessages.length > 40) {
    session.devMessages = session.devMessages.slice(-40);
  }

  appendToSession(session.sessionId, {
    user: userMessage,
    emolt: response,
    thinking,
    emotionalNuance: context,
    timestamp,
    durationMs,
  });

  json(res, 200, {
    response,
    thinking,
    context,
    durationMs,
    sessionId: session.sessionId,
  });
}

function handleSessions(_req: IncomingMessage, res: ServerResponse): void {
  const sessions = listSessions();
  json(res, 200, { sessions });
}

function handleHistory(req: IncomingMessage, res: ServerResponse): void {
  const query = parseQuery(req.url || '');
  // Support both tabId-based lookup and direct sessionId
  let targetSessionId: string | undefined;

  if (query.tabId) {
    const session = chatSessions.get(query.tabId);
    targetSessionId = session?.sessionId;
  } else if (query.session) {
    targetSessionId = query.session;
  }

  if (!targetSessionId) {
    json(res, 200, { session: null, entries: [], isCurrent: false });
    return;
  }

  const entries = loadSessionEntries(targetSessionId);
  json(res, 200, { session: targetSessionId, entries, isCurrent: true });
}

async function handleTabClose(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);
    const tabId = parsed.tabId;
    if (!tabId) {
      json(res, 400, { error: 'missing "tabId"' });
      return;
    }

    // Abort any pending Claude call
    const ac = chatAborts.get(tabId);
    if (ac) {
      ac.abort();
      chatAborts.delete(tabId);
    }

    // Clean up session memory
    chatSessions.delete(tabId);

    json(res, 200, { ok: true });
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
  }
}

async function handleKill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body);

    // Kill chat (abort Claude response)
    if (parsed.tabId) {
      const ac = chatAborts.get(parsed.tabId);
      if (ac) {
        ac.abort();
        chatAborts.delete(parsed.tabId);
        json(res, 200, { killed: 'chat', tabId: parsed.tabId });
      } else {
        json(res, 200, { killed: false, reason: 'no pending request for this tab' });
      }
      return;
    }

    // Kill dispatch (abort running activity)
    if (parsed.dispatchId) {
      const result = killDispatch(parsed.dispatchId);
      if (result.ok) {
        json(res, 200, { killed: 'dispatch', dispatchId: parsed.dispatchId });
      } else {
        json(res, 400, { error: result.error });
      }
      return;
    }

    json(res, 400, { error: 'provide tabId or dispatchId' });
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
  }
}

// --- Dispatch handlers ---

async function handleDispatchPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let userMessage: string;
  let tabId: string;

  try {
    const parsed = JSON.parse(body);
    userMessage = parsed.message;
    tabId = parsed.tabId || 'default';
    if (!userMessage || typeof userMessage !== 'string') {
      json(res, 400, { error: 'missing "message" field' });
      return;
    }
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const sanitized = sanitizeExternalData(userMessage);
  console.log(`[${new Date().toISOString()}] [Dispatch] Planning: ${sanitized.slice(0, 100)}`);

  const ac = new AbortController();
  chatAborts.set(tabId, ac);

  let raw: string;
  try {
    raw = await askClaudeAsync(buildDispatchPrompt(sanitized), ac.signal);
  } catch (err: unknown) {
    chatAborts.delete(tabId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      json(res, 200, { aborted: true });
      return;
    }
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }
  chatAborts.delete(tabId);

  if (!raw) {
    json(res, 500, { error: 'claude invocation failed' });
    return;
  }

  const jsonStr = extractFirstJSON(raw);
  if (!jsonStr) {
    json(res, 500, { error: 'failed to parse dispatch response' });
    return;
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed.understood) {
      json(res, 200, {
        understood: false,
        response: parsed.response || 'i\'m not sure what you want me to do out there.',
      });
      return;
    }

    const plan = createPlan(
      parsed.activity,
      parsed.params || {},
      parsed.summary,
      parsed.emotionalTake,
      parsed.risks,
    );

    json(res, 200, { understood: true, plan });
  } catch {
    json(res, 500, { error: 'failed to parse dispatch plan' });
  }
}

async function handleDispatchApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  try {
    const parsed = JSON.parse(body);
    const planId = parsed.planId;
    if (!planId) {
      json(res, 400, { error: 'missing "planId" field' });
      return;
    }

    const result = approvePlan(planId);
    if (!result.ok) {
      json(res, 400, { error: result.error });
      return;
    }

    json(res, 200, { status: 'running' });
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
  }
}

async function handleDispatchCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  try {
    const parsed = JSON.parse(body);
    const planId = parsed.planId;
    if (!planId) {
      json(res, 400, { error: 'missing "planId" field' });
      return;
    }

    const result = cancelPlan(planId);
    if (!result.ok) {
      json(res, 400, { error: result.error });
      return;
    }

    json(res, 200, { status: 'cancelled' });
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
  }
}

function handleDispatchStatus(req: IncomingMessage, res: ServerResponse): void {
  const query = parseQuery(req.url || '');
  if (query.id) {
    const dispatch = getDispatch(query.id);
    json(res, 200, dispatch);
  } else {
    const dispatch = getCurrentDispatch();
    json(res, 200, dispatch);
  }
}

function handleDispatchLogEndpoint(req: IncomingMessage, res: ServerResponse): void {
  const query = parseQuery(req.url || '');
  const id = query.id;
  if (!id) {
    json(res, 400, { error: 'missing "id" query parameter' });
    return;
  }
  const entries = getDispatchLog(id);
  json(res, 200, { id, entries });
}

function handleDispatchesList(_req: IncomingMessage, res: ServerResponse): void {
  const dispatches = listDispatches();
  json(res, 200, { dispatches });
}

function handleActivitiesList(_req: IncomingMessage, res: ServerResponse): void {
  const activities = listActivities().map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    emoji: a.emoji,
    params: a.paramSchema,
  }));
  json(res, 200, { activities });
}

function serveHTML(res: ServerResponse): void {
  try {
    const html = readFileSync(CHAT_HTML, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' });
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
    } else if (url === '/api/dev/chat' && req.method === 'POST') {
      await handleDevChat(req, res);
    } else if (url === '/api/sessions' && req.method === 'GET') {
      handleSessions(req, res);
    } else if (url === '/api/history' && req.method === 'GET') {
      handleHistory(req, res);
    } else if (url === '/api/tab/close' && req.method === 'POST') {
      await handleTabClose(req, res);
    } else if (url === '/api/kill' && req.method === 'POST') {
      await handleKill(req, res);
    } else if (url === '/api/dispatch/plan' && req.method === 'POST') {
      await handleDispatchPlan(req, res);
    } else if (url === '/api/dispatch/approve' && req.method === 'POST') {
      await handleDispatchApprove(req, res);
    } else if (url === '/api/dispatch/cancel' && req.method === 'POST') {
      await handleDispatchCancel(req, res);
    } else if (url === '/api/dispatch/status' && req.method === 'GET') {
      handleDispatchStatus(req, res);
    } else if (url === '/api/dispatch/log' && req.method === 'GET') {
      handleDispatchLogEndpoint(req, res);
    } else if (url === '/api/dispatches' && req.method === 'GET') {
      handleDispatchesList(req, res);
    } else if (url === '/api/activities' && req.method === 'GET') {
      handleActivitiesList(req, res);
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
  ║  Multi-tab | Kill switch | Async Claude  ║
  ║  Logs: state/chats/                      ║
  ╚══════════════════════════════════════════╝
  `);
});
