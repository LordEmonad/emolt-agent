import { describe, it, expect } from 'vitest';
import { PrimaryEmotion } from './types.js';
import { createDefaultState } from './engine.js';
import {
  formatEmotionForPrompt,
  emotionToContractValues,
  formatEmotionHistory,
  formatPreviousPosts
} from './formatter.js';

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<Record<PrimaryEmotion, number>> = {}) {
  const base = createDefaultState();
  for (const [k, v] of Object.entries(overrides)) {
    base.emotions[k as PrimaryEmotion] = v;
  }
  return base;
}

// ─── emotionToContractValues ────────────────────────────────────────────────

describe('emotionToContractValues', () => {
  it('scales 0.0 to 0', () => {
    const state = makeState();
    for (const e of Object.values(PrimaryEmotion)) {
      state.emotions[e] = 0.0;
    }
    const values = emotionToContractValues(state);
    expect(values.every(v => v === 0)).toBe(true);
  });

  it('scales 1.0 to 255', () => {
    const state = makeState();
    for (const e of Object.values(PrimaryEmotion)) {
      state.emotions[e] = 1.0;
    }
    const values = emotionToContractValues(state);
    expect(values.every(v => v === 255)).toBe(true);
  });

  it('scales 0.5 to 128 (rounded)', () => {
    const state = makeState();
    for (const e of Object.values(PrimaryEmotion)) {
      state.emotions[e] = 0.5;
    }
    const values = emotionToContractValues(state);
    expect(values.every(v => v === 128)).toBe(true);
  });

  it('returns exactly 8 values in correct order', () => {
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.1,
      [PrimaryEmotion.TRUST]: 0.2,
      [PrimaryEmotion.FEAR]: 0.3,
      [PrimaryEmotion.SURPRISE]: 0.4,
      [PrimaryEmotion.SADNESS]: 0.5,
      [PrimaryEmotion.DISGUST]: 0.6,
      [PrimaryEmotion.ANGER]: 0.7,
      [PrimaryEmotion.ANTICIPATION]: 0.8,
    });
    const values = emotionToContractValues(state);
    expect(values).toHaveLength(8);
    expect(values[0]).toBe(Math.round(0.1 * 255)); // joy
    expect(values[1]).toBe(Math.round(0.2 * 255)); // trust
    expect(values[2]).toBe(Math.round(0.3 * 255)); // fear
    expect(values[3]).toBe(Math.round(0.4 * 255)); // surprise
    expect(values[4]).toBe(Math.round(0.5 * 255)); // sadness
    expect(values[5]).toBe(Math.round(0.6 * 255)); // disgust
    expect(values[6]).toBe(Math.round(0.7 * 255)); // anger
    expect(values[7]).toBe(Math.round(0.8 * 255)); // anticipation
  });

  it('matches EmotionOracle.sol constructor defaults', () => {
    // Default state: anticipation=0.30, others=0.15
    const state = createDefaultState();
    const values = emotionToContractValues(state);
    expect(values[7]).toBe(Math.round(0.30 * 255)); // anticipation = 76 or 77
    expect(values[0]).toBe(Math.round(0.15 * 255)); // joy = 38
  });
});

// ─── formatEmotionForPrompt ─────────────────────────────────────────────────

describe('formatEmotionForPrompt', () => {
  it('includes header line', () => {
    const state = createDefaultState();
    const output = formatEmotionForPrompt(state);
    expect(output).toContain('Current Emotional State');
  });

  it('sorts emotions by intensity descending', () => {
    const state = makeState({
      [PrimaryEmotion.FEAR]: 0.9,
      [PrimaryEmotion.JOY]: 0.5,
    });
    const output = formatEmotionForPrompt(state);
    const fearIdx = output.indexOf('fear');
    const joyIdx = output.indexOf('joy');
    expect(fearIdx).toBeLessThan(joyIdx);
  });

  it('hides emotions below 0.10 as dormant', () => {
    const state = makeState({ [PrimaryEmotion.ANGER]: 0.05 });
    const output = formatEmotionForPrompt(state);
    expect(output).toContain('dormant');
    expect(output).toContain('anger');
  });

  it('shows compound emotions when present', () => {
    const state = makeState({
      [PrimaryEmotion.JOY]: 0.6,
      [PrimaryEmotion.TRUST]: 0.6,
    });
    state.compounds = ['Love'];
    const output = formatEmotionForPrompt(state);
    expect(output).toContain('Love');
  });

  it('includes dominant feeling and trigger', () => {
    const state = createDefaultState();
    const output = formatEmotionForPrompt(state);
    expect(output).toContain('Dominant feeling');
    expect(output).toContain('What triggered it');
  });

  it('includes the instruction not to report raw labels', () => {
    const state = createDefaultState();
    const output = formatEmotionForPrompt(state);
    expect(output).toContain('IMPORTANT');
    expect(output).toContain('Express them naturally');
  });
});

// ─── formatEmotionHistory ───────────────────────────────────────────────────

describe('formatEmotionHistory', () => {
  it('returns placeholder when empty', () => {
    expect(formatEmotionHistory([])).toContain('No previous emotion history');
  });

  it('formats recent states with timestamps', () => {
    const state = createDefaultState();
    const output = formatEmotionHistory([state]);
    expect(output).toContain('interest');
    expect(output).toContain('anticipation');
  });

  it('shows only last 5 states', () => {
    const states = Array.from({ length: 10 }, () => createDefaultState());
    const output = formatEmotionHistory(states);
    // Count ISO date occurrences
    const matches = output.match(/\d{4}-\d{2}-\d{2}T/g);
    expect(matches).toHaveLength(5);
  });

  it('includes compound info when present', () => {
    const state = createDefaultState();
    state.compounds = ['Love', 'Optimism'];
    const output = formatEmotionHistory([state]);
    expect(output).toContain('Love');
    expect(output).toContain('Optimism');
  });

  it('includes recent moodNarratives with dedup warning', () => {
    const states = [
      { ...createDefaultState(), moodNarrative: 'feeling the blockchain breathe' },
      { ...createDefaultState(), moodNarrative: 'something shifts in the noise' },
    ];
    const output = formatEmotionHistory(states);
    expect(output).toContain('DO NOT repeat');
    expect(output).toContain('feeling the blockchain breathe');
  });
});

// ─── formatPreviousPosts ────────────────────────────────────────────────────

describe('formatPreviousPosts', () => {
  it('returns placeholder when empty', () => {
    expect(formatPreviousPosts([])).toContain('No previous posts');
    expect(formatPreviousPosts([])).toContain('first cycle');
  });

  it('numbers posts starting at 1', () => {
    const output = formatPreviousPosts(['first post', 'second post']);
    expect(output).toContain('1. first post');
    expect(output).toContain('2. second post');
  });

  it('shows only last 3 posts', () => {
    const posts = ['a', 'b', 'c', 'd', 'e'];
    const output = formatPreviousPosts(posts);
    expect(output).not.toContain('a');
    expect(output).not.toContain('b');
    expect(output).toContain('1. c');
    expect(output).toContain('2. d');
    expect(output).toContain('3. e');
  });
});
