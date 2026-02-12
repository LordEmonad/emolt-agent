// --- Dispatch Queue: Sequential dispatch chaining ---
// Allows queuing multiple dispatch plans for auto-execution

import { approvePlan, getDispatch, createPlan } from './runner.js';

interface QueuedDispatch {
  activity: string;
  params: Record<string, unknown>;
  summary: string;
  emotionalTake: string;
  risks: string;
}

interface DispatchQueue {
  items: QueuedDispatch[];
  currentPlanId: string | null;
  running: boolean;
  completedIds: string[];
  pollInterval: ReturnType<typeof setInterval> | null;
}

const queues = new Map<string, DispatchQueue>();

function getOrCreateQueue(queueId: string): DispatchQueue {
  let q = queues.get(queueId);
  if (!q) {
    q = { items: [], currentPlanId: null, running: false, completedIds: [], pollInterval: null };
    queues.set(queueId, q);
  }
  return q;
}

/**
 * Add a dispatch to the queue. If nothing is running, starts immediately.
 */
export function enqueueDispatch(
  queueId: string,
  activity: string,
  params: Record<string, unknown>,
  summary: string,
  emotionalTake: string,
  risks: string,
): { position: number; queueLength: number; startedImmediately: boolean } {
  const q = getOrCreateQueue(queueId);

  q.items.push({ activity, params, summary, emotionalTake, risks });
  const position = q.items.length;

  let startedImmediately = false;
  if (!q.running) {
    startedImmediately = advanceQueue(queueId);
  }

  return { position, queueLength: q.items.length, startedImmediately };
}

/**
 * Try to advance the queue to the next item. Returns true if a new dispatch was started.
 */
function advanceQueue(queueId: string): boolean {
  const q = queues.get(queueId);
  if (!q || q.items.length === 0) {
    if (q) q.running = false;
    return false;
  }

  const next = q.items.shift()!;
  const plan = createPlan(next.activity, next.params, next.summary, next.emotionalTake, next.risks);

  q.currentPlanId = plan.id;
  q.running = true;

  // Auto-approve
  const result = approvePlan(plan.id);
  if (!result.ok) {
    console.error(`[Queue] Failed to approve queued plan: ${result.error}`);
    q.running = false;
    q.currentPlanId = null;
    return false;
  }

  // Start polling for completion
  pollForCompletion(queueId, plan.id);
  return true;
}

/**
 * Poll until the current dispatch completes, then advance the queue.
 */
function pollForCompletion(queueId: string, planId: string): void {
  const q = queues.get(queueId);
  const interval = setInterval(() => {
    const dispatch = getDispatch(planId);
    if (!dispatch.plan) {
      clearInterval(interval);
      if (q) q.pollInterval = null;
      advanceQueue(queueId);
      return;
    }

    const status = dispatch.plan.status;
    if (status === 'complete' || status === 'failed' || status === 'killed' || status === 'cancelled') {
      clearInterval(interval);
      if (q) {
        q.pollInterval = null;
        q.completedIds.push(planId);
        q.currentPlanId = null;
      }
      // Small delay before advancing
      setTimeout(() => advanceQueue(queueId), 2000);
    }
  }, 5_000); // Check every 5s

  if (q) q.pollInterval = interval;
}

/**
 * Get queue status.
 */
export function getQueueStatus(queueId: string): {
  running: boolean;
  currentPlanId: string | null;
  pending: number;
  completed: string[];
} {
  const q = queues.get(queueId);
  if (!q) return { running: false, currentPlanId: null, pending: 0, completed: [] };
  return {
    running: q.running,
    currentPlanId: q.currentPlanId,
    pending: q.items.length,
    completed: q.completedIds,
  };
}

/**
 * Clear the queue (stop executing future items, but don't kill current dispatch).
 */
export function clearQueue(queueId: string): { cleared: number } {
  const q = queues.get(queueId);
  if (!q) return { cleared: 0 };
  const cleared = q.items.length;
  q.items = [];
  if (q.pollInterval) {
    clearInterval(q.pollInterval);
    q.pollInterval = null;
  }
  q.running = false;
  q.currentPlanId = null;
  return { cleared };
}

/**
 * List all active queues.
 */
export function listQueues(): Array<{ id: string; pending: number; running: boolean; currentPlanId: string | null }> {
  const result: Array<{ id: string; pending: number; running: boolean; currentPlanId: string | null }> = [];
  for (const [id, q] of queues) {
    result.push({ id, pending: q.items.length, running: q.running, currentPlanId: q.currentPlanId });
  }
  return result;
}
