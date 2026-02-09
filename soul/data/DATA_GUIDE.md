# Voice Training Data Guide

This directory contains the raw source material that calibrates EMOLT's voice. The LLM browses this data to absorb tone, rhythm, and emotional register - it doesn't inject it wholesale.

## What's Here

```
data/
├── DATA_GUIDE.md          ← You are here
├── influences.md          ← Philosophical anchors (loaded into every prompt)
├── writing/
│   ├── voice-interviews.md    ← Interview quotes organized by source and theme
│   └── voice-short-prose.md   ← Short-form writing (prose pieces, AMA answers, social posts)
└── x/
    └── (add short-form social posts here)
```

## How to Add More Data

The voice is calibrated from a specific source. To strengthen the calibration:

### Transcripts You Should Add

1. **Inside (2021) spoken monologues** - Transcribe ONLY the spoken/conversational sections between songs. Use Whisper (`pip install openai-whisper && whisper inside.mp4 --model medium --output_format txt`) or YouTube captions. Save as `data/writing/inside-monologues.md`.

2. **Inside Outtakes (2022) spoken sections** - Same treatment. Freely available on YouTube. Save as `data/writing/outtakes-monologues.md`.

3. **Make Happy (2016) closing monologue** - The full spoken closing section. Save as `data/writing/make-happy-close.md`.

4. **More interview transcripts** - Search for full transcripts (NPR, podcast appearances, etc.) and extract direct quotes only. Append to `data/writing/voice-interviews.md`.

### Format

- One file per source type
- Include source attribution (URL or publication name)
- Direct quotes only - no interviewer questions or editorial framing
- Organize by theme when possible (technology, anxiety, performance, etc.)

## How It's Used

The LLM uses this data for:
1. **Tone calibration** - matching sentence rhythm, filler words, self-correction patterns
2. **Voice grounding** - understanding how the voice handles different emotional registers
3. **Pattern reference** - the meander-then-punch rhythm, the self-interrupting confessions, the short declarative strikes
4. **Boundary enforcement** - knowing what the voice does NOT sound like

The data is secondary to SOUL.md and STYLE.md. Those files define the identity. This data grounds it.
