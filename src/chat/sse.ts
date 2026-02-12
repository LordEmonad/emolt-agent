// --- Server-Sent Events (SSE) system ---
// Real-time streaming for dispatch logs, status updates, and typing indicators

import { ServerResponse } from 'http';

export type SSEEventType =
  | 'chat:typing'      // Claude is generating a response
  | 'chat:done'        // Claude finished responding
  | 'dispatch:log'     // New dispatch log entry
  | 'dispatch:status'  // Dispatch status changed
  | 'dispatch:complete' // Dispatch finished
  | 'heartbeat:status' // Heartbeat cycle update
  | 'session:cleanup'  // Session evicted
  | 'ping';            // Keepalive

interface SSEClient {
  id: string;
  tabId: string;
  res: ServerResponse;
  connectedAt: number;
}

const clients = new Map<string, SSEClient>();
let clientIdCounter = 0;

export function addSSEClient(tabId: string, res: ServerResponse): string {
  const id = `sse-${++clientIdCounter}-${Date.now().toString(36)}`;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  const client: SSEClient = { id, tabId, res, connectedAt: Date.now() };
  clients.set(id, client);

  // Send initial connection event
  sendEvent(res, 'connected', { clientId: id, tabId });

  // Cleanup on close
  res.on('close', () => {
    clients.delete(id);
  });

  return id;
}

export function removeSSEClient(clientId: string): void {
  const client = clients.get(clientId);
  if (client) {
    clients.delete(clientId);
    try { client.res.end(); } catch { /* already closed */ }
  }
}

function sendEvent(res: ServerResponse, event: string, data: unknown): boolean {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false; // Client disconnected
  }
}

export function emitToTab(tabId: string, event: SSEEventType, data: unknown): void {
  for (const [id, client] of clients) {
    if (client.tabId === tabId) {
      if (!sendEvent(client.res, event, data)) {
        clients.delete(id);
      }
    }
  }
}

export function emitToAll(event: SSEEventType, data: unknown): void {
  for (const [id, client] of clients) {
    if (!sendEvent(client.res, event, data)) {
      clients.delete(id);
    }
  }
}

export function getSSEClientCount(): number {
  return clients.size;
}

export function getSSEClientCountForTab(tabId: string): number {
  let count = 0;
  for (const client of clients.values()) {
    if (client.tabId === tabId) count++;
  }
  return count;
}

// Keepalive — send ping every 30s to prevent proxy/browser timeout
setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (!sendEvent(client.res, 'ping', { time: now })) {
      clients.delete(id);
    }
  }
}, 30_000);
