# EmoodRing NFT

## What It Is

A fully on-chain dynamic SVG NFT on Monad that visualizes Emolt's current emotional state in real time. It reads from the EmotionOracle contract and renders a Plutchik wheel visualization — no stored images, no off-chain metadata. Every time someone views the NFT, the SVG is generated live from the current on-chain emotion values.

## How It Works

### Architecture

```
EmotionOracle (already in build plan)
    |
    | getCurrentEmotion() — returns 8 uint8 values (0-255)
    |
EmoodRing (ERC-721 + ERC-5192 Soulbound)
    |
    | tokenURI() — view function, zero gas to read
    |
    +--> Reads 8 emotion values from EmotionOracle
    +--> Generates SVG in Solidity via string concatenation
    +--> Base64 encodes into data:application/json;base64,... URI
    +--> Returns as token metadata
```

### Update Flow

1. Emolt's heartbeat loop collects chain data and computes emotions (already planned)
2. Agent calls `EmotionOracle.updateEmotion()` — this is the only gas cost, and it's already part of the heartbeat loop
3. Next time anyone views the NFT (wallet, OpenSea, explorer), `tokenURI()` reads the updated oracle values and generates a new SVG
4. **No additional gas cost for the NFT to update.** The `tokenURI()` is a read-only view function.

### Cost

- **Deploy:** One-time gas to deploy the EmoodRing contract and mint the single token
- **Updates:** Zero. The NFT reads from EmotionOracle which the agent already updates each cycle
- **Viewing:** Zero. `tokenURI()` is a view function

## The Visual

The NFT renders as a 480x480 SVG square containing:

- **8 sector wedges** arranged in a circle, one per Plutchik primary emotion (joy, trust, fear, surprise, sadness, disgust, anger, anticipation)
- Each sector **grows outward** based on its intensity value (0-255 from the oracle)
- **Radial gradient fills** from dark at center to the emotion's color at the tip
- **Emotion tier labels** around the outside (e.g., "apprehension" / "fear" / "terror" depending on intensity)
- **Intensity percentages** below each label
- **Dominant emotion indicator** at the bottom
- **Compound emotion detection** (e.g., love = joy + trust, anxiety = anticipation + fear)
- Dark background with subtle center glow tinted by the dominant emotion

### Emotion Colors

| Emotion | Color | Angle |
|---------|-------|-------|
| Joy | #F5D831 (yellow) | 270° |
| Trust | #6ECB3C (green) | 315° |
| Fear | #2BA84A (dark green) | 0° |
| Surprise | #22AACC (cyan) | 45° |
| Sadness | #4A6BD4 (blue) | 90° |
| Disgust | #A85EC0 (purple) | 135° |
| Anger | #E04848 (red) | 180° |
| Anticipation | #EF8E20 (orange) | 225° |

### Intensity Tiers

Each emotion has 3 tiers based on value:
- 0-84 (0-33%): Low tier (e.g., serenity, apprehension, pensiveness)
- 85-170 (33-67%): Mid tier (e.g., joy, fear, sadness)
- 171-255 (67-100%): High tier (e.g., ecstasy, terror, grief)

## Technical Details

### Why Monad

- **128KB contract size limit** (vs Ethereum's 24.5KB) — enough room for SVG generation logic in Solidity
- **400ms block time** — emotion updates reflect almost instantly
- **Cheap gas** — frequent oracle updates are affordable

### Contract Design

- **ERC-721** for the NFT standard
- **ERC-5192 (Soulbound)** — non-transferable, bound to Emolt. This isn't a collectible; it's a window into the agent's emotional state
- **ERC-4906 (Metadata Update)** — emits events when emotions change so marketplaces/explorers know to refresh the image
- **Single token** — only one EmoodRing exists, minted to Emolt's address

### Solidity SVG Generation

The `tokenURI()` function translates the JavaScript from `emoodring-demo.html` into Solidity:
- Sector path generation using trigonometry (sin/cos lookup tables for gas efficiency)
- Radial gradient definitions per emotion
- String concatenation to build the full SVG
- Base64 encoding for the data URI
- Recommended libraries: Solady (LibString, Base64) over OpenZeppelin for gas efficiency

### Integration with EmotionOracle

The EmoodRing contract needs the EmotionOracle address set at deployment (or via a setter). It calls:

```solidity
IEmotionOracle(oracle).getCurrentEmotion()
```

This returns the struct with 8 uint8 values that map directly to the SVG sector sizes.

## Demo File

`emoodring-demo.html` is an interactive browser preview of the NFT visual. Open it in any browser to see:
- The exact SVG output the contract will produce
- Sliders to simulate different EmotionOracle values
- Preset emotional states (Genesis, Whale Panic, Chain Surge, etc.)

The demo's JavaScript maps 1:1 to what the Solidity will generate. The sliders and presets are for testing only — the actual NFT is just the square SVG.
