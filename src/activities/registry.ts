import type { ActivityConfig } from './types.js';

const activities = new Map<string, ActivityConfig>();

export function registerActivity(config: ActivityConfig): void {
  activities.set(config.id, config);
}

export function getActivity(id: string): ActivityConfig | undefined {
  return activities.get(id);
}

export function listActivities(): ActivityConfig[] {
  return Array.from(activities.values());
}
