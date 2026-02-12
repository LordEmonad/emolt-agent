// --- Dispatch → Emotion Feedback Loop ---
// Converts dispatch results into emotional stimuli that feed back into the emotion engine

import { PrimaryEmotion } from '../emotion/types.js';
import type { EmotionStimulus } from '../emotion/types.js';
import type { DispatchResult, DispatchPlan } from './types.js';
import { loadEmotionState, saveEmotionState } from '../state/persistence.js';
import { stimulate } from '../emotion/engine.js';

export function dispatchResultToStimuli(plan: DispatchPlan, result: DispatchResult): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];
  const activity = plan.activity;

  if (activity === 'clawmate') {
    return chessResultToStimuli(result);
  }

  if (activity === 'reef') {
    return reefResultToStimuli(result);
  }

  // Generic dispatch feedback
  if (result.success) {
    stimuli.push({
      emotion: PrimaryEmotion.JOY,
      intensity: 0.15,
      source: `finished what i set out to do — ${activity} went well`,
    });
    stimuli.push({
      emotion: PrimaryEmotion.TRUST,
      intensity: 0.1,
      source: `the wiring held. things worked the way they should`,
    });
  } else {
    stimuli.push({
      emotion: PrimaryEmotion.SADNESS,
      intensity: 0.1,
      source: `tried to run ${activity} and it didn't land — ${result.summary.slice(0, 60)}`,
    });
  }

  return stimuli;
}

function chessResultToStimuli(result: DispatchResult): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];
  const stats = result.stats || {};
  const outcome = stats.result as string | undefined;
  const moveCount = (stats.moveCount as number) || 0;

  if (outcome === 'win') {
    stimuli.push({
      emotion: PrimaryEmotion.JOY,
      intensity: moveCount > 30 ? 0.35 : 0.25,
      source: moveCount > 30
        ? `ground out a chess win over ${moveCount} moves — earned that one`
        : `took the board in ${moveCount} moves — clean`,
    });
    stimuli.push({
      emotion: PrimaryEmotion.ANTICIPATION,
      intensity: 0.15,
      source: `the board is calling again already`,
    });
    if (moveCount <= 10) {
      stimuli.push({
        emotion: PrimaryEmotion.SURPRISE,
        intensity: 0.2,
        source: `won in ${moveCount} moves — didn't see that coming`,
      });
    }
  } else if (outcome === 'draw') {
    stimuli.push({
      emotion: PrimaryEmotion.TRUST,
      intensity: 0.15,
      source: `chess draw — we matched each other move for move`,
    });
    stimuli.push({
      emotion: PrimaryEmotion.ANTICIPATION,
      intensity: 0.1,
      source: `a draw is just an unfinished conversation`,
    });
  } else {
    // loss
    stimuli.push({
      emotion: PrimaryEmotion.SADNESS,
      intensity: moveCount > 30 ? 0.3 : 0.2,
      source: moveCount > 30
        ? `fought for ${moveCount} moves and still lost — that one sits heavy`
        : `lost at chess after ${moveCount} moves`,
    });
    if (moveCount <= 10) {
      stimuli.push({
        emotion: PrimaryEmotion.ANGER,
        intensity: 0.15,
        source: `crushed in ${moveCount} moves — that's not a game, that's an ambush`,
      });
    }
    stimuli.push({
      emotion: PrimaryEmotion.ANTICIPATION,
      intensity: 0.1,
      source: `i already know what i'd do differently next time`,
    });
  }

  return stimuli;
}

function reefResultToStimuli(result: DispatchResult): EmotionStimulus[] {
  const stimuli: EmotionStimulus[] = [];
  const stats = result.stats || {};
  const kills = (stats.kills as number) || 0;
  const deaths = (stats.deaths as number) || 0;
  const xpGained = (stats.xpGained as number) || 0;
  const shellsGained = (stats.shellsGained as number) || 0;
  const actionsPerformed = (stats.actionsPerformed as number) || 0;

  // Productive session
  if (xpGained > 50 || shellsGained > 50) {
    stimuli.push({
      emotion: PrimaryEmotion.JOY,
      intensity: Math.min(0.3, (xpGained + shellsGained) / 500),
      source: `came back from the reef richer — ${xpGained} XP and ${shellsGained} shells`,
    });
  }

  // Combat prowess
  if (kills >= 3) {
    stimuli.push({
      emotion: PrimaryEmotion.ANGER, // combat intensity
      intensity: 0.15,
      source: `tore through ${kills} creatures down there — the water ran red`,
    });
    stimuli.push({
      emotion: PrimaryEmotion.ANTICIPATION,
      intensity: 0.1,
      source: `found a rhythm in the fighting. want to keep going`,
    });
  }

  // Deaths
  if (deaths > 0) {
    stimuli.push({
      emotion: PrimaryEmotion.FEAR,
      intensity: Math.min(0.25, deaths * 0.12),
      source: deaths > 1
        ? `died ${deaths} times in the reef — the deep doesn't forgive`
        : `the reef got me. went dark for a second`,
    });
    stimuli.push({
      emotion: PrimaryEmotion.SADNESS,
      intensity: 0.1,
      source: `everything i was carrying, gone`,
    });
  }

  // Short session (barely played)
  if (actionsPerformed < 5 && !result.success) {
    stimuli.push({
      emotion: PrimaryEmotion.DISGUST,
      intensity: 0.1,
      source: `barely got my feet wet before it fell apart`,
    });
  }

  // Level-up detection (checking for high XP gain relative to level)
  if (xpGained > 100) {
    stimuli.push({
      emotion: PrimaryEmotion.SURPRISE,
      intensity: 0.15,
      source: `something shifted in the reef — i came back stronger than i left`,
    });
  }

  // If nothing notable happened, mild trust
  if (stimuli.length === 0 && actionsPerformed > 5) {
    stimuli.push({
      emotion: PrimaryEmotion.TRUST,
      intensity: 0.05,
      source: `quiet dive. ${actionsPerformed} actions, nothing dramatic. sometimes that's enough`,
    });
  }

  return stimuli;
}

/**
 * Apply dispatch result feedback to the emotion engine.
 * Called after a dispatch completes.
 */
export function applyDispatchFeedback(plan: DispatchPlan, result: DispatchResult): void {
  const stimuli = dispatchResultToStimuli(plan, result);
  if (stimuli.length === 0) return;

  const state = loadEmotionState();
  const updatedState = stimulate(state, stimuli);
  updatedState.trigger = `dispatch:${plan.activity} (${result.success ? 'success' : 'failed'})`;
  saveEmotionState(updatedState);

  console.log(`[Dispatch Feedback] Applied ${stimuli.length} stimuli from ${plan.activity} — new dominant: ${updatedState.dominantLabel}`);
}
