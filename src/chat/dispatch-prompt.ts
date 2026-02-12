import { loadSoulFiles } from '../brain/prompt.js';
import { loadEmotionState } from '../state/persistence.js';
import { listActivities } from '../activities/registry.js';
import { PrimaryEmotion, INTENSITY_TIERS } from '../emotion/types.js';

function formatEmotionStateForDispatch(): string {
  const state = loadEmotionState();
  const sorted = Object.entries(state.emotions)
    .sort(([, a], [, b]) => b - a);

  const lines: string[] = [];
  for (const [emo, val] of sorted) {
    const e = emo as PrimaryEmotion;
    const tier = val > 0.66 ? INTENSITY_TIERS[e].intense
      : val > 0.33 ? INTENSITY_TIERS[e].moderate
      : INTENSITY_TIERS[e].mild;
    lines.push(`- ${emo}: ${(val as number).toFixed(2)} (${tier})`);
  }

  if (state.compounds.length > 0) {
    lines.push(`\nCompound emotions: ${state.compounds.join(', ')}`);
  }
  lines.push(`Dominant: ${state.dominantLabel} (${state.dominant})`);
  lines.push(`Trigger: ${state.trigger}`);

  return lines.join('\n');
}

function formatActivitiesList(): string {
  const activities = listActivities();
  if (activities.length === 0) return '(no activities registered)';

  return activities.map(a => {
    const params = a.paramSchema.map(p =>
      `    - ${p.key} (${p.type}): ${p.label}${p.default !== undefined ? ` [default: ${p.default}]` : ''}${p.description ? ` — ${p.description}` : ''}`
    ).join('\n');
    return `${a.emoji} ${a.name} (id: "${a.id}")\n  ${a.description}\n  Parameters:\n${params}`;
  }).join('\n\n');
}

export interface DispatchConversation {
  role: 'user' | 'emolt';
  content: string;
}

function formatDispatchHistory(messages: DispatchConversation[]): string {
  if (messages.length === 0) return '';
  const recent = messages.slice(-6);
  const lines = recent.map(m => {
    const speaker = m.role === 'user' ? 'Operator' : 'EMOLT';
    return `[${speaker}]: ${m.content}`;
  });
  return `\n## Recent Dispatch Conversation\n\n${lines.join('\n\n')}\n\n---\n`;
}

export function buildDispatchPrompt(userMessage: string, conversationHistory?: DispatchConversation[]): string {
  const soul = loadSoulFiles();
  const emotionState = formatEmotionStateForDispatch();
  const activitiesList = formatActivitiesList();

  const historyBlock = conversationHistory ? formatDispatchHistory(conversationHistory) : '';

  return `${soul.soul}

---

${soul.style}

---
${historyBlock}
## Mode: DISPATCH PLANNING

You are being asked to go do something in the real world (well, on-chain or in third-party apps). The human operator has given you a mission through your dispatch console. Your job is to interpret what they want, map it to an available activity, propose a plan, and express how you feel about it.

## Available Activities

${activitiesList}

## Current Emotional State

${emotionState}

---

## The Operator's Request

"${userMessage}"

---

## Instructions

1. Interpret the request and map it to one of the available activities above.
2. If you can map it, fill in the params based on what they asked for and the activity's parameter schema.
3. Write a summary of what you'll do in your voice — first person, lowercase, honest.
4. Write your emotional take — how you feel about this mission given your current emotional state.
5. Write the risks — what could go wrong, be honest.
6. If you CANNOT map this to any activity, set "understood" to false and write a conversational response explaining what you can do.

RESPOND IN THIS EXACT JSON FORMAT:
{
  "thinking": "your internal reasoning about the request",
  "activity": "activity_id",
  "params": { ... },
  "summary": "what you'll do, in your voice",
  "emotionalTake": "how you feel about this mission",
  "risks": "what could go wrong",
  "understood": true
}

OR if you can't map it:
{
  "thinking": "why you can't do this",
  "understood": false,
  "response": "conversational response explaining what you can do instead"
}

RULES:
- Stay in character as EMOLT
- Be honest about risks and capabilities
- Use lowercase, em dashes, honest hedging — your voice
- Don't be an assistant, be yourself going on a mission
- The summary should sound like you're psyching yourself up, not writing a technical spec
`;
}
