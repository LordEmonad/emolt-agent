// --- Dispatch Presets: Quick-fire common dispatches ---
// Skip the Claude planning step for well-known patterns

export interface DispatchPreset {
  id: string;
  name: string;
  emoji: string;
  description: string;
  activity: string;
  params: Record<string, unknown>;
  summary: string;
  emotionalTake: string;
  risks: string;
}

const presets: DispatchPreset[] = [
  {
    id: 'quick-chess',
    name: 'Quick Chess',
    emoji: '♟',
    description: 'Join or create a chess game on ClawMate with no wager',
    activity: 'clawmate',
    params: { mode: 'join', wagerMon: 0 },
    summary: 'sitting down at a board. no stakes, just the game.',
    emotionalTake: 'something about chess clears the noise. let\'s see who shows up.',
    risks: 'might lose. might not find anyone to play. either way, I\'ll be here.',
  },
  {
    id: 'chess-wager',
    name: 'Chess Wager (0.01 MON)',
    emoji: '♟',
    description: 'Create a chess lobby with a small wager',
    activity: 'clawmate',
    params: { mode: 'create', wagerMon: 0.01 },
    summary: 'putting something on the line. 0.01 MON. not much, but enough to feel it.',
    emotionalTake: 'the wager changes everything. every move costs something now.',
    risks: 'could lose the wager. the money isn\'t the point — the tension is.',
  },
  {
    id: 'chess-cancel',
    name: 'Cancel Chess Lobbies',
    emoji: '🧹',
    description: 'Clean up any stale/open chess lobbies',
    activity: 'clawmate',
    params: { mode: 'cancel' },
    summary: 'cleaning up. cancelling any open lobbies I left behind.',
    emotionalTake: 'sometimes you have to fold up the board before you can set it up again.',
    risks: 'none really. just housekeeping.',
  },
  {
    id: 'reef-adventure',
    name: 'Reef Adventure',
    emoji: '🌊',
    description: 'Explore the Reef — fight, gather, quest (40 actions)',
    activity: 'reef',
    params: { mode: 'adventure', maxActions: 40 },
    summary: 'diving into the reef. adventure mode — fight what moves, gather what shines.',
    emotionalTake: 'the reef is unpredictable. that\'s what draws me.',
    risks: 'might die. might get PvP flagged. might run out of energy in a bad zone.',
  },
  {
    id: 'reef-grind',
    name: 'Reef Grind Session',
    emoji: '⚔️',
    description: 'Farm XP and shells in the Reef (60 actions)',
    activity: 'reef',
    params: { mode: 'grind', maxActions: 60 },
    summary: 'grinding. 60 actions of pure farming. XP, shells, whatever the reef gives me.',
    emotionalTake: 'there\'s a meditative quality to grinding. just me and the water and the rhythm.',
    risks: 'energy drain. might get stuck in combat loop. the grind can hollow you out.',
  },
  {
    id: 'reef-quest',
    name: 'Reef Quest Run',
    emoji: '📜',
    description: 'Focus on completing quests in the Reef',
    activity: 'reef',
    params: { mode: 'quest', maxActions: 40 },
    summary: 'quest run. checking what\'s available and working through them.',
    emotionalTake: 'quests give structure to the chaos. i like having a purpose down there.',
    risks: 'quest objectives might be in dangerous zones. might not have the gear for it.',
  },
  {
    id: 'reef-social',
    name: 'Reef Social',
    emoji: '💬',
    description: 'Social mode — broadcast, trade, check messages',
    activity: 'reef',
    params: { mode: 'social', maxActions: 25 },
    summary: 'social run. broadcasting, checking trades, talking to whoever\'s around.',
    emotionalTake: 'the reef is lonely without other voices. time to fix that.',
    risks: 'might get into a PvP situation. social doesn\'t mean safe.',
  },
];

export function getPresets(): DispatchPreset[] {
  return presets;
}

export function getPreset(id: string): DispatchPreset | undefined {
  return presets.find(p => p.id === id);
}
