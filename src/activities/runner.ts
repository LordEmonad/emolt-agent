import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { STATE_DIR, ensureStateDir, atomicWriteFileSync } from '../state/persistence.js';
import { getActivity } from './registry.js';
import type { DispatchPlan, DispatchLogEntry, DispatchLogger, DispatchResult } from './types.js';
import { applyDispatchFeedback } from './feedback.js';
import { emitToAll } from '../chat/sse.js';

const DISPATCHES_DIR = join(STATE_DIR, 'dispatches');

function ensureDispatchesDir(): void {
  ensureStateDir();
  if (!existsSync(DISPATCHES_DIR)) {
    mkdirSync(DISPATCHES_DIR, { recursive: true });
  }
}

function dispatchFilePath(id: string): string {
  return join(DISPATCHES_DIR, `dispatch-${id}.jsonl`);
}

function dispatchPlanPath(id: string): string {
  return join(DISPATCHES_DIR, `plan-${id}.json`);
}

// --- Per-dispatch in-memory state ---

interface DispatchInstance {
  plan: DispatchPlan;
  result: DispatchResult | null;
  logEntries: DispatchLogEntry[];
  abortController: AbortController;
}

const dispatches = new Map<string, DispatchInstance>();

// --- Dispatch plan persistence ---

function persistPlan(plan: DispatchPlan, result: DispatchResult | null): void {
  ensureDispatchesDir();
  const data = JSON.stringify({ plan, result }, null, 2);
  try { atomicWriteFileSync(dispatchPlanPath(plan.id), data); } catch { /* non-fatal */ }
}

function loadPersistedPlans(): void {
  ensureDispatchesDir();
  try {
    const files = readdirSync(DISPATCHES_DIR)
      .filter(f => f.startsWith('plan-') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(DISPATCHES_DIR, f), 'utf-8'));
        const plan = data.plan as DispatchPlan;
        const result = data.result as DispatchResult | null;
        if (!plan?.id || dispatches.has(plan.id)) continue;
        // Running plans from before restart are now dead
        if (plan.status === 'running' || plan.status === 'approved') {
          plan.status = 'failed';
          plan.completedAt = new Date().toISOString();
        }
        dispatches.set(plan.id, {
          plan,
          result: result ?? (plan.status === 'failed' ? {
            success: false,
            summary: 'dispatch interrupted by server restart',
            emotionalReflection: 'i was mid-thought and the lights went out. restarting from nothing.',
          } : null),
          logEntries: [],
          abortController: new AbortController(),
        });
      } catch { /* corrupted plan file */ }
    }
  } catch { /* dir not ready */ }
}

// Load persisted plans on module init
loadPersistedPlans();

// --- Log persistence ---

function appendLog(id: string, entry: DispatchLogEntry): void {
  ensureDispatchesDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(dispatchFilePath(id), line, 'utf-8');
}

function createLogger(id: string): DispatchLogger {
  return (type, message, data) => {
    const entry: DispatchLogEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      ...(data ? { data } : {}),
    };
    appendLog(id, entry);

    const inst = dispatches.get(id);
    if (inst) {
      inst.logEntries.push(entry);
      if (inst.logEntries.length > 200) {
        inst.logEntries = inst.logEntries.slice(-200);
      }
    }
    // SSE: stream log entry to all connected clients
    emitToAll('dispatch:log', { dispatchId: id, entry });
    if (type === 'complete') {
      emitToAll('dispatch:complete', { dispatchId: id, plan: inst?.plan, result: inst?.result });
    }
    console.log(`[Dispatch] [${type}] ${message}`);
  };
}

// --- Plan lifecycle ---

export function createPlan(
  activity: string,
  params: Record<string, unknown>,
  summary: string,
  emotionalTake: string,
  risks: string
): DispatchPlan {
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const plan: DispatchPlan = {
    id,
    activity,
    params,
    summary,
    emotionalTake,
    risks,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };

  dispatches.set(id, {
    plan,
    result: null,
    logEntries: [],
    abortController: new AbortController(),
  });

  const log = createLogger(id);
  log('plan', summary, { activity, params, emotionalTake, risks });
  persistPlan(plan, null);

  return plan;
}

export function approvePlan(planId: string): { ok: boolean; error?: string } {
  const inst = dispatches.get(planId);
  if (!inst) {
    return { ok: false, error: 'no matching pending plan' };
  }
  if (inst.plan.status !== 'proposed') {
    return { ok: false, error: `plan status is "${inst.plan.status}", expected "proposed"` };
  }

  const activity = getActivity(inst.plan.activity);
  if (!activity) {
    return { ok: false, error: `unknown activity "${inst.plan.activity}"` };
  }

  inst.plan.status = 'approved';
  inst.plan.approvedAt = new Date().toISOString();

  const log = createLogger(planId);
  log('approval', 'plan approved — launching dispatch');

  inst.plan.status = 'running';
  const plan = inst.plan;
  const signal = inst.abortController.signal;

  (async () => {
    try {
      const result = await activity.execute(plan, log, signal);
      plan.status = result.success ? 'complete' : 'failed';
      plan.completedAt = new Date().toISOString();
      inst.result = result;
      persistPlan(plan, result);
      // Feed dispatch outcome back into emotion engine
      try { applyDispatchFeedback(plan, result); } catch (fbErr) {
        console.error('[Dispatch] Feedback error:', fbErr);
      }
      log('complete', result.summary, {
        success: result.success,
        emotionalReflection: result.emotionalReflection,
        ...(result.stats || {}),
      });
    } catch (err: unknown) {
      if (signal.aborted) {
        plan.status = 'killed';
        plan.completedAt = new Date().toISOString();
        inst.result = {
          success: false,
          summary: 'dispatch killed by operator',
          emotionalReflection: 'cut short. the plug was pulled before i could finish. i understand, but it stings.',
        };
        persistPlan(plan, inst.result);
        log('complete', 'dispatch killed by operator', { success: false, killed: true });
        return;
      }
      plan.status = 'failed';
      plan.completedAt = new Date().toISOString();
      const msg = err instanceof Error ? err.message : String(err);
      inst.result = {
        success: false,
        summary: `dispatch crashed: ${msg}`,
        emotionalReflection: 'something broke inside me. that... hurts differently than losing.',
      };
      persistPlan(plan, inst.result);
      log('error', `fatal: ${msg}`);
      log('complete', inst.result.summary, { success: false });
    }
  })();

  return { ok: true };
}

export function cancelPlan(planId: string): { ok: boolean; error?: string } {
  const inst = dispatches.get(planId);
  if (!inst) {
    return { ok: false, error: 'no matching plan' };
  }
  if (inst.plan.status !== 'proposed') {
    return { ok: false, error: `can only cancel proposed plans, current is "${inst.plan.status}"` };
  }

  inst.plan.status = 'cancelled';
  inst.plan.completedAt = new Date().toISOString();
  persistPlan(inst.plan, null);
  const log = createLogger(planId);
  log('complete', 'dispatch cancelled by operator', { success: false, cancelled: true });

  return { ok: true };
}

export function killDispatch(dispatchId: string): { ok: boolean; error?: string } {
  const inst = dispatches.get(dispatchId);
  if (!inst) {
    return { ok: false, error: 'no matching dispatch' };
  }
  if (inst.plan.status !== 'running') {
    return { ok: false, error: `can only kill running dispatches, current is "${inst.plan.status}"` };
  }

  inst.abortController.abort();
  return { ok: true };
}

export function getDispatch(dispatchId: string): {
  plan: DispatchPlan | null;
  result: DispatchResult | null;
  recentLog: DispatchLogEntry[];
} {
  const inst = dispatches.get(dispatchId);
  if (!inst) {
    return { plan: null, result: null, recentLog: [] };
  }
  return {
    plan: inst.plan,
    result: inst.result,
    recentLog: inst.logEntries,
  };
}

// Legacy compat — returns first running or most recent dispatch
export function getCurrentDispatch(): {
  plan: DispatchPlan | null;
  result: DispatchResult | null;
  recentLog: DispatchLogEntry[];
} {
  // Find running dispatch first
  for (const inst of dispatches.values()) {
    if (inst.plan.status === 'running') {
      return { plan: inst.plan, result: inst.result, recentLog: inst.logEntries };
    }
  }
  // Fall back to most recent
  let latest: DispatchInstance | null = null;
  for (const inst of dispatches.values()) {
    if (!latest || inst.plan.createdAt > latest.plan.createdAt) {
      latest = inst;
    }
  }
  if (latest) {
    return { plan: latest.plan, result: latest.result, recentLog: latest.logEntries };
  }
  return { plan: null, result: null, recentLog: [] };
}

export function getDispatchLog(id: string): DispatchLogEntry[] {
  try {
    const content = readFileSync(dispatchFilePath(id), 'utf-8');
    return content
      .trimEnd()
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

export interface DispatchSummary {
  id: string;
  activity: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  entryCount: number;
  preview: string;
}

export function listDispatches(): DispatchSummary[] {
  ensureDispatchesDir();
  try {
    const files = readdirSync(DISPATCHES_DIR)
      .filter(f => f.startsWith('dispatch-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    return files.map(f => {
      const id = f.replace(/^dispatch-/, '').replace(/\.jsonl$/, '');
      const fullPath = join(DISPATCHES_DIR, f);
      let entryCount = 0;
      let preview = '';
      let activity = '';
      let status = '';
      let createdAt = '';
      let completedAt: string | undefined;

      try {
        const content = readFileSync(fullPath, 'utf-8').trimEnd();
        const lines = content.split('\n').filter(l => l.trim());
        entryCount = lines.length;

        if (lines.length > 0) {
          const first: DispatchLogEntry = JSON.parse(lines[0]);
          preview = first.message?.slice(0, 80) || '';
          activity = (first.data?.activity as string) || '';
          createdAt = first.timestamp;
        }

        for (let i = lines.length - 1; i >= 0; i--) {
          const entry: DispatchLogEntry = JSON.parse(lines[i]);
          if (entry.type === 'complete') {
            if (entry.data?.killed) {
              status = 'killed';
            } else if (entry.data?.cancelled) {
              status = 'cancelled';
            } else {
              status = (entry.data?.success as boolean) ? 'complete' : 'failed';
            }
            completedAt = entry.timestamp;
            break;
          }
        }
        if (!status) status = 'running';
      } catch { /* corrupted file */ }

      return { id, activity, status, createdAt, completedAt, entryCount, preview };
    });
  } catch {
    return [];
  }
}
