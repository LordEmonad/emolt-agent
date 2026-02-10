// --- Dispatch Mode: Activity Framework Types ---

export interface ParamField {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  default?: unknown;
  description?: string;
}

export interface ActivityConfig {
  id: string;
  name: string;
  description: string;
  emoji: string;
  paramSchema: ParamField[];
  execute: (plan: DispatchPlan, log: DispatchLogger, signal: AbortSignal) => Promise<DispatchResult>;
}

export interface DispatchPlan {
  id: string;
  activity: string;
  params: Record<string, unknown>;
  summary: string;
  emotionalTake: string;
  risks: string;
  status: 'proposed' | 'approved' | 'running' | 'complete' | 'failed' | 'cancelled' | 'killed';
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
}

export interface DispatchLogEntry {
  timestamp: string;
  type: 'plan' | 'approval' | 'step' | 'thought' | 'action' | 'result' | 'error' | 'complete';
  message: string;
  data?: Record<string, unknown>;
}

export type DispatchLogger = (
  type: DispatchLogEntry['type'],
  message: string,
  data?: Record<string, unknown>
) => void;

export interface DispatchResult {
  success: boolean;
  summary: string;
  emotionalReflection: string;
  stats?: Record<string, unknown>;
}
