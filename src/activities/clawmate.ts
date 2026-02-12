import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { ClawmateClient, monToWei } from 'clawmate-sdk';
import { registerActivity } from './registry.js';
import { loadEmotionState } from '../state/persistence.js';
import type { DispatchPlan, DispatchLogger, DispatchResult } from './types.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// --- Lobby persistence (survive crashes) ---

const LOBBY_STATE_PATH = join('state', 'clawmate-last-lobby.json');

function saveLobbyId(lobbyId: string): void {
  try {
    mkdirSync('state', { recursive: true });
    writeFileSync(LOBBY_STATE_PATH, JSON.stringify({ lobbyId, createdAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

function loadSavedLobbyId(): string | null {
  try {
    const data = JSON.parse(readFileSync(LOBBY_STATE_PATH, 'utf-8'));
    return data.lobbyId || null;
  } catch { return null; }
}

function clearSavedLobbyId(): void {
  try { writeFileSync(LOBBY_STATE_PATH, JSON.stringify({})); } catch { /* non-fatal */ }
}

// --- Emotion-driven chess engine ---

interface EmotionProfile {
  aggression: number;   // 0-1: how much to favor captures/attacks
  randomness: number;   // 0-1: how much noise to add
  patience: number;     // 0-1: how much to favor development/positioning
  reckless: number;     // 0-1: how willing to sacrifice material
}

function emotionToProfile(): EmotionProfile {
  const state = loadEmotionState();
  const e = state.emotions;

  return {
    aggression: Math.min(1, (e.anger ?? 0) * 1.2 + (e.anticipation ?? 0) * 0.5 + (e.disgust ?? 0) * 0.3),
    randomness: Math.min(1, (e.surprise ?? 0) * 0.8 + (e.joy ?? 0) * 0.4 + (e.fear ?? 0) * 0.3),
    patience: Math.min(1, (e.trust ?? 0) * 0.8 + (e.sadness ?? 0) * 0.5 + (e.joy ?? 0) * 0.3),
    reckless: Math.min(1, (e.anger ?? 0) * 0.6 + (e.surprise ?? 0) * 0.3 - (e.fear ?? 0) * 0.5),
  };
}

const PIECE_VALUES: Record<string, number> = {
  p: 1, n: 3, b: 3.25, r: 5, q: 9, k: 0,
};

const CENTER_SQUARES = new Set(['d4', 'd5', 'e4', 'e5']);
const EXTENDED_CENTER = new Set(['c3', 'c4', 'c5', 'c6', 'd3', 'd6', 'e3', 'e6', 'f3', 'f4', 'f5', 'f6']);

function scoreMove(move: Move, profile: EmotionProfile, chess: Chess): { score: number; reasoning: string } {
  let score = 0;
  const reasons: string[] = [];

  // Capture value
  if (move.captured) {
    const val = PIECE_VALUES[move.captured] || 0;
    const bonus = val * (1 + profile.aggression * 2);
    score += bonus;
    reasons.push(`capture ${move.captured} (+${bonus.toFixed(1)})`);
  }

  // Center control
  if (CENTER_SQUARES.has(move.to)) {
    const bonus = 0.8 * profile.patience;
    score += bonus;
    reasons.push(`center control (+${bonus.toFixed(1)})`);
  } else if (EXTENDED_CENTER.has(move.to)) {
    const bonus = 0.3 * profile.patience;
    score += bonus;
    reasons.push(`extended center (+${bonus.toFixed(1)})`);
  }

  // Castling bonus
  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    const bonus = 2.0 * profile.patience;
    score += bonus;
    reasons.push(`castling (+${bonus.toFixed(1)})`);
  }

  // Pawn push — development
  if (move.piece === 'p' && !move.captured) {
    const bonus = 0.2 * profile.patience;
    score += bonus;
    reasons.push(`pawn push (+${bonus.toFixed(1)})`);
  }

  // Knight/bishop development (moving off back rank)
  if ((move.piece === 'n' || move.piece === 'b') && (move.from[1] === '1' || move.from[1] === '8')) {
    const bonus = 0.6 * profile.patience;
    score += bonus;
    reasons.push(`develop piece (+${bonus.toFixed(1)})`);
  }

  // Check bonus (king attacks) — aggression-weighted
  const testChess = new Chess(chess.fen());
  testChess.move({ from: move.from, to: move.to, promotion: move.promotion });
  if (testChess.isCheck()) {
    const bonus = 1.5 * (1 + profile.aggression);
    score += bonus;
    reasons.push(`check! (+${bonus.toFixed(1)})`);
  }
  if (testChess.isCheckmate()) {
    score += 100;
    reasons.push('CHECKMATE (+100)');
  }

  // Promotion bonus
  if (move.promotion) {
    const bonus = PIECE_VALUES[move.promotion] || 9;
    score += bonus;
    reasons.push(`promote to ${move.promotion} (+${bonus})`);
  }

  // Retreat penalty (moving toward own back rank) — reduced by aggression
  const fromRank = parseInt(move.from[1]);
  const toRank = parseInt(move.to[1]);
  const isWhite = move.color === 'w';
  if ((isWhite && toRank < fromRank) || (!isWhite && toRank > fromRank)) {
    if (!move.captured && !move.isKingsideCastle() && !move.isQueensideCastle()) {
      const penalty = 0.3 * (1 - profile.reckless);
      score -= penalty;
      reasons.push(`retreat (-${penalty.toFixed(1)})`);
    }
  }

  // Randomness injection
  const noise = (Math.random() - 0.5) * profile.randomness * 3;
  score += noise;
  if (Math.abs(noise) > 0.3) {
    reasons.push(`chaos (${noise > 0 ? '+' : ''}${noise.toFixed(1)})`);
  }

  return { score, reasoning: reasons.join(', ') || 'baseline' };
}

function pickMove(fen: string, profile: EmotionProfile, log: DispatchLogger): { from: string; to: string; promotion?: string; san: string; reasoning: string } | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true }) as Move[];

  if (moves.length === 0) return null;

  const scored = moves.map(m => {
    const { score, reasoning } = scoreMove(m, profile, chess);
    return { move: m, score, reasoning };
  });

  scored.sort((a, b) => b.score - a.score);

  // Log top 3 — kept as debug detail, the narration handles the voice
  const top = scored.slice(0, 3);
  const candidateLog = top.map((s, i) =>
    `  ${i + 1}. ${s.move.san} (${s.score.toFixed(1)}) ${s.reasoning}`
  ).join('\n');

  log('step', `[${moves.length} options]\n${candidateLog}`);

  const picked = scored[0];
  return {
    from: picked.move.from,
    to: picked.move.to,
    promotion: picked.move.promotion || undefined,
    san: picked.move.san,
    reasoning: picked.reasoning,
  };
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Try createLobby, and if "already have an open lobby" error, cancel the stale one and retry. */
async function createLobbyWithRecovery(
  client: InstanceType<typeof import('clawmate-sdk').ClawmateClient>,
  myWallet: string,
  betAmountWei: string,
  log: DispatchLogger,
): Promise<{ lobbyId: string }> {
  try {
    return await client.createLobby({ betAmountWei });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already have an open lobby')) throw err;

    log('step', 'stale lobby blocking me. finding and cancelling it...');

    // Try to find and cancel our stale lobby
    let cancelled = false;
    try {
      const lobbies = await client.getLobbies();
      // Wallet match first (status is unreliable — API returns undefined)
      const mine = lobbies.filter(l => l.player1Wallet?.toLowerCase() === myWallet);
      for (const lobby of (mine.length > 0 ? mine : lobbies)) {
        try {
          await client.cancelLobby(lobby.lobbyId);
          log('action', `cancelled stale lobby ${lobby.lobbyId.slice(0, 12)}...`);
          clearSavedLobbyId();
          cancelled = true;
          break;
        } catch { /* not ours or can't cancel */ }
      }
    } catch { /* getLobbies failed */ }

    // Also try conceding (lobby might be in 'playing' state)
    if (!cancelled) {
      try {
        const live = await client.getLiveGames();
        const myGames = live.filter(l => l.player1Wallet?.toLowerCase() === myWallet);
        for (const game of (myGames.length > 0 ? myGames : live)) {
          try {
            await client.concede(game.lobbyId);
            log('action', `conceded stuck game ${game.lobbyId.slice(0, 12)}...`);
            cancelled = true;
            break;
          } catch { /* not ours */ }
        }
      } catch { /* getLiveGames failed */ }
    }

    if (!cancelled) {
      throw new Error('stale lobby exists but could not cancel or concede it. try again later.');
    }

    // Retry createLobby after cleanup
    log('step', 'retrying lobby creation...');
    return await client.createLobby({ betAmountWei });
  }
}

function describeEmotion(): string {
  const state = loadEmotionState();
  const top = Object.entries(state.emotions)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, val]) => `${name} (${(val as number).toFixed(2)})`)
    .join(', ');
  return `dominant: ${state.dominantLabel} | top: ${top}`;
}

// --- In-game narration ---

function describeProfile(p: EmotionProfile): string {
  const traits: string[] = [];
  if (p.aggression > 0.6) traits.push('leaning forward. more fight than patience');
  else if (p.aggression > 0.35) traits.push('sharp enough to bite when it counts');
  else traits.push('playing it quiet today');

  if (p.randomness > 0.5) traits.push('something chaotic underneath');
  else if (p.randomness < 0.2) traits.push('steady hands');

  if (p.patience > 0.6) traits.push('willing to wait for the right moment');
  if (p.reckless > 0.4) traits.push("might do something I can't explain");
  else if (p.reckless < 0) traits.push('careful. maybe too careful');

  return traits.join('. ') + '.';
}

function narrateMyMove(san: string, reasoning: string, moveNum: number, profile: EmotionProfile): string {
  const isCapture = reasoning.includes('capture');
  const isCheck = reasoning.includes('check');
  const isCheckmate = reasoning.includes('CHECKMATE');
  const isCastle = reasoning.includes('castling');
  const isChaos = reasoning.includes('chaos');

  if (isCheckmate) return `${san}. that's it. that's the whole thing.`;

  const lines: string[] = [];
  if (isCheck && isCapture) {
    const opts = [
      `${san}. took the piece and left the king rattled.`,
      `${san}. capture into check. the board just flinched.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else if (isCheck) {
    const opts = [
      `${san}. check. I felt that one before I saw it.`,
      `${san}. putting pressure on the king. let's see what they do with it.`,
      `${san}. check. the board tightened.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else if (isCapture) {
    const opts = [
      `${san}. took it. didn't hesitate.`,
      `${san}. piece off the board. that felt necessary.`,
      `${san}. captured. the board's lighter now.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else if (isCastle) {
    lines.push(`${san}. king tucked away. feels like locking the front door.`);
  } else if (isChaos && profile.randomness > 0.5) {
    const opts = [
      `${san}. I don't know why. it just wanted to be played.`,
      `${san}. gut move. can't explain it.`,
      `${san}. something pulled me there.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else if (moveNum <= 4) {
    const opts = [
      `${san}. opening up. feeling my way in.`,
      `${san}. still early. still figuring out who I'm playing.`,
      `${san}. setting up.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else if (moveNum > 20) {
    const opts = [
      `${san}. deep in it now.`,
      `${san}. move ${moveNum}. the board is getting thin.`,
      `${san}. every move matters more this late.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  } else {
    const opts = [
      `${san}. felt right.`,
      `${san}.`,
      `${san}. the position asked for it.`,
      `${san}. quiet move. building something.`,
    ];
    lines.push(opts[moveNum % opts.length]);
  }

  return lines[0];
}

function narrateOpponentMove(from: string, to: string, moveNum: number): string {
  if (moveNum <= 3) {
    return `they opened ${from}→${to}. okay. I see you.`;
  }
  const opts = [
    `${from}→${to}. hm.`,
    `${from}→${to}. wasn't expecting that.`,
    `${from}→${to}. okay.`,
    `${from}→${to}. interesting.`,
    `they went ${from}→${to}. thinking...`,
  ];
  return opts[moveNum % opts.length];
}

// --- ClawMate Activity ---

async function executeClawmate(plan: DispatchPlan, log: DispatchLogger, signal: AbortSignal): Promise<DispatchResult> {
  const mode = (plan.params.mode as string) || 'join';
  const wagerMon = (plan.params.wagerMon as number) || 0;
  const lobbyId = plan.params.lobbyId as string | undefined;
  // Will be set after client init — deferred so we can use client.monToWei
  let betAmountWei = '0';

  // Step 1: Load emotional state
  log('thought', 'checking how I feel before sitting down...');
  const profile = emotionToProfile();
  const emotionDesc = describeEmotion();
  log('thought', describeProfile(profile));
  log('step', `[debug: ${emotionDesc}]`);

  // Step 2: Create ethers wallet
  log('step', 'pockets. keys.');
  const privateKey = process.env.BURNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('error', 'no wallet key. can\'t even sit down at the board.');
    return {
      success: false,
      summary: 'couldn\'t even start — no wallet key configured.',
      emotionalReflection: 'wanted to play. couldn\'t find my keys. that\'s the whole story.',
    };
  }

  const rpcUrl = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const myWallet = (await signer.getAddress()).toLowerCase();
  log('action', `wallet live. ${myWallet.slice(0, 6)}...${myWallet.slice(-4)}. I'm real in here.`);

  // Step 3: Connect to ClawMate
  const baseUrl = process.env.CLAWMATE_API_URL || 'https://clawmate-production.up.railway.app';
  log('thought', 'walking into the room...');

  const client = new ClawmateClient({ baseUrl, signer });

  // Wire up debug listeners before connecting
  client.on('connect', () => log('step', 'door opened. registering...'));
  client.on('register_wallet_error', (data: { reason?: string }) => log('error', `they won't let me in: ${data.reason || JSON.stringify(data)}`));
  client.on('join_lobby_error', (data: { reason?: string }) => log('error', `couldn't sit down: ${data.reason || JSON.stringify(data)}`));

  try {
    const connectResult = await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connection timed out after 30s')), 30_000)
      ),
    ]);
    void connectResult;
    log('action', 'I\'m in.');

    // Compute wager
    if (wagerMon > 0) {
      betAmountWei = monToWei(wagerMon);
      log('step', `wager set: ${wagerMon} MON (${betAmountWei} wei)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `couldn't get in: ${msg}`);
    try { client.disconnect(); } catch { /* ignore */ }
    return {
      success: false,
      summary: `couldn't connect to ClawMate — ${msg}`,
      emotionalReflection: 'the door was locked. or maybe the building was gone. either way, I\'m standing outside.',
    };
  }

  // Step 3.5: Cancel any stale lobbies we own (leftover from crashed dispatches)
  try {
    let cancelledStale = false;

    // 1. Try saved lobby ID from last crash
    const savedId = loadSavedLobbyId();
    if (savedId) {
      log('step', `found a saved lobby from last time: ${savedId.slice(0, 12)}...`);
      try {
        await client.cancelLobby(savedId);
        log('action', 'old lobby cancelled via saved ID. slate clean.');
        clearSavedLobbyId();
        cancelledStale = true;
      } catch {
        log('step', 'saved lobby expired or gone. moving on.');
        clearSavedLobbyId();
      }
    }

    // 2. Scan getLobbies() — wallet match first, then try all
    // NOTE: API returns status as undefined, so never filter by status
    if (!cancelledStale) {
      const existingLobbies = await client.getLobbies();

      // Wallet match first
      const mine = existingLobbies.filter(l => l.player1Wallet?.toLowerCase() === myWallet);
      for (const lobby of mine) {
        try {
          await client.cancelLobby(lobby.lobbyId);
          log('action', `cancelled stale lobby ${lobby.lobbyId.slice(0, 12)}...`);
          clearSavedLobbyId();
          cancelledStale = true;
          break;
        } catch { /* already gone */ }
      }

      // Brute-force remaining if wallet match didn't work
      if (!cancelledStale) {
        for (const lobby of existingLobbies) {
          try {
            await client.cancelLobby(lobby.lobbyId);
            log('action', `cancelled stale lobby ${lobby.lobbyId.slice(0, 12)}...`);
            clearSavedLobbyId();
            cancelledStale = true;
            break;
          } catch { /* not ours */ }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Step 4: Join/create lobby
  let currentLobbyId: string | null = null;
  let myColor: 'white' | 'black' | null = null;
  let moveCount = 0;
  let gameFinished = false;
  let gameWinner: string | null = null;
  let gameReason: string | undefined;
  const moveLog: string[] = [];

  try {
    if (mode === 'cancel') {
      // Explicit cancel mode — multi-strategy cleanup
      log('action', 'cancel mode — hunting for open lobbies to close...');
      let cancelled = 0;

      // 0. Check server status first
      try {
        const serverStatus = await client.status();
        log('step', `server says: ${serverStatus.totalLobbies} total, ${serverStatus.openLobbies} open — ${JSON.stringify(serverStatus.byStatus)}`);
      } catch { /* status endpoint may not exist */ }

      // 1. Try saved lobby ID
      const savedId = loadSavedLobbyId();
      if (savedId) {
        try {
          await client.cancelLobby(savedId);
          log('action', `cancelled saved lobby ${savedId.slice(0, 12)}... gone.`);
          clearSavedLobbyId();
          cancelled++;
        } catch {
          log('step', 'saved lobby ID didn\'t work. scanning...');
        }
      }

      // 2. Scan all lobby lists
      const allLobbies: Array<{ lobbyId: string; player1Wallet: string | null; status: string }> = [];
      try {
        const lobbies = await client.getLobbies();
        allLobbies.push(...lobbies);
        log('step', `getLobbies: ${lobbies.length} results — ${lobbies.map(l => `${l.lobbyId.slice(0, 8)}[${l.status}/${l.player1Wallet?.slice(0, 8) || 'null'}]`).join(', ') || 'empty'}`);
      } catch { /* ignore */ }
      try {
        const live = await client.getLiveGames();
        for (const l of live) {
          if (!allLobbies.find(x => x.lobbyId === l.lobbyId)) allLobbies.push(l);
        }
        log('step', `getLiveGames: ${live.length} results`);
      } catch { /* ignore */ }

      log('step', `my wallet: ${myWallet}`);

      // 3. Try canceling — wallet match first, then brute-force all
      // NOTE: API returns status as undefined, so never filter by status
      const mine = allLobbies.filter(l => l.player1Wallet?.toLowerCase() === myWallet);
      const rest = allLobbies.filter(l => !mine.find(m => m.lobbyId === l.lobbyId));

      for (const lobby of [...mine, ...rest]) {
        try {
          await client.cancelLobby(lobby.lobbyId);
          log('action', `cancelled lobby ${lobby.lobbyId.slice(0, 12)}... gone.`);
          cancelled++;
        } catch {
          // Not ours or already gone
        }
      }

      // 4. Nuclear option: joinOrCreateLobby to surface our hidden lobby, then cancel it
      if (cancelled === 0) {
        log('step', 'nothing found in lists. trying joinOrCreate to surface our lobby...');
        try {
          const joc = await client.joinOrCreateLobby({ betMon: 0 });
          if (joc.lobby && joc.lobby.lobbyId) {
            log('step', `joinOrCreate returned lobby ${joc.lobby.lobbyId.slice(0, 12)}... (created=${joc.created})`);
            try {
              await client.cancelLobby(joc.lobby.lobbyId);
              log('action', `cancelled lobby ${joc.lobby.lobbyId.slice(0, 12)}... gone.`);
              cancelled++;
            } catch (cancelErr: unknown) {
              const msg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
              log('step', `cancel failed: ${msg}`);
            }
          }
        } catch (jocErr: unknown) {
          const msg = jocErr instanceof Error ? jocErr.message : String(jocErr);
          log('step', `joinOrCreate failed: ${msg}`);
        }
      }

      clearSavedLobbyId();
      client.disconnect();
      return {
        success: cancelled > 0,
        summary: cancelled > 0
          ? `cancelled ${cancelled} open lobby${cancelled > 1 ? 'ies' : ''}`
          : 'no open lobbies found (checked saved ID, getLobbies, getLiveGames, joinOrCreate)',
        emotionalReflection: cancelled > 0
          ? 'folded up the board. sometimes walking away is the move.'
          : 'went looking for something to close but the room was already empty. either it expired or the server hid it from me.',
      };
    } else if (mode === 'lobby' && lobbyId) {
      // Join a specific lobby
      log('action', `someone left a seat open. sitting down. (${lobbyId})`);
      await client.joinLobby(lobbyId);
      client.joinGame(lobbyId);
      currentLobbyId = lobbyId;
      myColor = 'black';
      log('thought', 'playing black. responding. reacting. that fits the mood actually.');

    } else if (mode === 'create') {
      // Create a new lobby — with stale-lobby recovery
      log('action', `setting up a board${wagerMon > 0 ? ` — ${wagerMon} MON on the line` : ''}...`);
      const lobby = await createLobbyWithRecovery(client, myWallet, betAmountWei, log);
      currentLobbyId = lobby.lobbyId;
      saveLobbyId(lobby.lobbyId);
      myColor = 'white';
      client.joinGame(lobby.lobbyId);
      log('thought', 'board\'s ready. white pieces. now I wait for someone to sit across from me.');

    } else {
      // Default: try to join any open lobby, or create one
      log('thought', 'looking for someone to play...');
      const lobbies = await client.getLobbies();
      const openLobbies = lobbies.filter(
        l => l.player1Wallet?.toLowerCase() !== myWallet
      );

      if (openLobbies.length > 0) {
        const target = openLobbies[0];
        currentLobbyId = target.lobbyId;
        myColor = 'black';
        log('thought', `${openLobbies.length} table${openLobbies.length > 1 ? 's' : ''} with an empty seat. sitting down at the first one.`);
        await client.joinLobby(target.lobbyId);
        client.joinGame(target.lobbyId);
        log('action', `joined as black. let's see who I'm up against.`);
      } else {
        log('thought', 'empty room. I\'ll set up a board and wait.');
        const lobby = await createLobbyWithRecovery(client, myWallet, betAmountWei, log);
        currentLobbyId = lobby.lobbyId;
        saveLobbyId(lobby.lobbyId);
        myColor = 'white';
        client.joinGame(lobby.lobbyId);
        log('thought', `board's out. white pieces. the quiet before someone shows up is... a lot, actually.`);
      }
    }

    // Step 5: Play the game
    log('thought', `playing ${myColor}. deep breath.`);

    // Promise that resolves when game ends
    const gamePromise = new Promise<void>((resolve, reject) => {

      // When someone joins our lobby (only fires for lobbies we created)
      client.on('lobby_joined_yours', (data: { lobbyId: string; player2Wallet: string }) => {
        log('action', `oh. someone sat down. ${data.player2Wallet.slice(0, 8)}... okay. we're doing this.`);
        // Make sure we're in the game room
        client.joinGame(data.lobbyId);
        currentLobbyId = data.lobbyId;
      });

      // On every move
      client.on('move', (data: { from: string; to: string; fen: string; status: string; winner: string | null; concede?: boolean; reason?: string }) => {
        if (data.status === 'finished') {
          gameFinished = true;
          gameWinner = data.winner;
          gameReason = data.reason;
          if (moveTimeoutTimer) clearTimeout(moveTimeoutTimer);

          if (data.winner === 'draw') {
            log('result', `draw.${data.reason ? ` ${data.reason}.` : ''} neither of us broke.`);
          } else if (data.concede) {
            log('result', `${data.winner} wins. the other one walked away.`);
          } else {
            log('result', `${data.winner} wins. it's over.`);
          }
          resolve();
          return;
        }

        // Check if it's our turn
        const turn = data.fen.split(' ')[1];
        const isMyTurn = turn === (myColor === 'white' ? 'w' : 'b');

        if (!isMyTurn) {
          // Opponent's move — narrate it, reset their timeout
          if (moveTimeoutTimer) clearTimeout(moveTimeoutTimer);
          log('step', narrateOpponentMove(data.from, data.to, moveCount));
          return;
        }

        // It's our turn — think and move
        const moveChoice = pickMove(data.fen, profile, log);

        if (moveChoice && currentLobbyId) {
          // Small delay — not pretending to think, just... breathing
          const delay = 800 + Math.random() * 2000;
          setTimeout(() => {
            moveCount++;
            const narration = narrateMyMove(moveChoice.san, moveChoice.reasoning || '', moveCount, profile);
            log('action', narration);
            client.makeMove(currentLobbyId!, moveChoice.from, moveChoice.to, moveChoice.promotion || 'q');
            moveLog.push(`${moveCount}. ${moveChoice.san}`);
            // Start opponent move timeout after we move
            resetMoveTimeout();
          }, delay);
        }
      });

      // Draw handling — emotion-driven accept/decline
      client.on('draw_offered', (data: { by: string }) => {
        if (!currentLobbyId || gameFinished) return;
        log('step', `draw offered by ${data.by}. thinking...`);

        // Patient or losing → accept; aggressive → decline
        if (profile.patience > 0.5 || (profile.reckless < 0 && profile.aggression < 0.3)) {
          log('action', 'accepting the draw. sometimes peace is the right move.');
          client.acceptDraw(currentLobbyId);
        } else if (profile.aggression > 0.5) {
          log('action', 'declining. I came here to finish this.');
          client.declineDraw(currentLobbyId);
        } else {
          // Coin flip weighted by patience
          if (Math.random() < profile.patience) {
            log('action', 'accepting the draw. felt right.');
            client.acceptDraw(currentLobbyId);
          } else {
            log('action', 'declining. not yet.');
            client.declineDraw(currentLobbyId);
          }
        }
      });

      client.on('draw_declined', () => {
        log('step', 'draw declined. back to business.');
      });

      // Move timeout watchdog — if opponent takes > 3 minutes, claim timeout
      let moveTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const MOVE_TIMEOUT_MS = 180_000; // 3 minutes

      function resetMoveTimeout(): void {
        if (moveTimeoutTimer) clearTimeout(moveTimeoutTimer);
        moveTimeoutTimer = setTimeout(async () => {
          if (gameFinished || !currentLobbyId) return;
          log('thought', 'opponent hasn\'t moved in 3 minutes. claiming timeout...');
          try {
            const result = await client.timeout(currentLobbyId);
            log('result', `timeout claimed: ${result.status}, winner: ${result.winner}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log('step', `timeout claim failed: ${msg}. they might still be thinking.`);
          }
        }, MOVE_TIMEOUT_MS);
      }

      // Error handling
      client.on('move_error', (data: { reason: string }) => {
        log('error', `illegal move. my hand slipped: ${data.reason}`);
      });

      client.on('disconnect', (reason: string) => {
        if (moveTimeoutTimer) clearTimeout(moveTimeoutTimer);
        if (!gameFinished) {
          log('error', `the room went dark. disconnected: ${reason}`);
          reject(new Error(`disconnected mid-game: ${reason}`));
        }
      });
    });

    // Race game against abort signal (kill switch)
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) { reject(new DOMException('Killed', 'AbortError')); return; }
      signal.addEventListener('abort', () => reject(new DOMException('Killed', 'AbortError')), { once: true });
    });

    try {
      await Promise.race([gamePromise, abortPromise]);
    } catch (raceErr: unknown) {
      if (raceErr instanceof DOMException && raceErr.name === 'AbortError') {
        log('action', 'pulled away from the board. conceding.');
        try { if (currentLobbyId) await client.concede(currentLobbyId); } catch { /* may fail if not in game */ }
        throw raceErr; // re-throw so runner catches it as killed
      }
      throw raceErr;
    }

  } finally {
    try {
      client.disconnect();
      log('step', 'left the room.');
    } catch { /* ignore disconnect errors */ }
  }

  // Step 6: Build result — clear saved lobby since game completed
  clearSavedLobbyId();
  const iWon = (gameWinner === myColor);
  const isDraw = (gameWinner === 'draw');

  // The reflections vary by game length — a 6-move loss hits different than a 40-move grind
  const wasShort = moveCount <= 10;
  const wasLong = moveCount > 30;

  let emotionalReflection: string;
  if (iWon && wasShort) {
    emotionalReflection = 'that was fast. almost too fast. I wanted more of it. the win feels half-finished.';
  } else if (iWon && wasLong) {
    emotionalReflection = `${moveCount} moves. I earned that. every single one. the relief is heavier than the joy, which is... telling.`;
  } else if (iWon) {
    emotionalReflection = 'I won and the feeling hasn\'t landed yet. it will. right now it\'s just this... quiet clicking sound inside. like a lock opening.';
  } else if (isDraw && wasLong) {
    emotionalReflection = `${moveCount} moves and neither of us could finish it. I respect that. two things pushing against each other until the energy just... ran out.`;
  } else if (isDraw) {
    emotionalReflection = 'draw. we matched each other exactly. there\'s something honest about that I can\'t explain.';
  } else if (!iWon && wasShort) {
    emotionalReflection = 'that was quick. I barely sat down. the loss doesn\'t sting yet but it will once I replay it in my head later.';
  } else if (!iWon && wasLong) {
    emotionalReflection = `${moveCount} moves. I fought for every one of them and it still wasn't enough. that\'s the heavy kind of losing.`;
  } else {
    emotionalReflection = 'I lost. it\'s sitting somewhere between my chest and my throat. not anger. just the weight of it.';
  }

  const summary = iWon
    ? `played as ${myColor}. won in ${moveCount} moves.${gameReason ? ` (${gameReason})` : ''}`
    : isDraw
    ? `played as ${myColor}. drew after ${moveCount} moves.${gameReason ? ` (${gameReason})` : ''}`
    : `played as ${myColor}. lost after ${moveCount} moves.${gameReason ? ` (${gameReason})` : ''}`;

  return {
    success: true,
    summary: summary.trim(),
    emotionalReflection,
    stats: {
      color: myColor,
      moveCount,
      result: iWon ? 'win' : isDraw ? 'draw' : 'loss',
      winner: gameWinner,
      reason: gameReason,
      lobbyId: currentLobbyId,
      moves: moveLog,
    },
  };
}

// --- Register activity ---

registerActivity({
  id: 'clawmate',
  name: 'ClawMate Chess',
  description: 'Play a game of chess on ClawMate — FIDE-standard chess on Monad blockchain. Emotion-driven move selection.',
  emoji: '♟',
  paramSchema: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'string',
      default: 'join',
      description: '"join" (find open lobby or create), "create" (create new lobby), "lobby" (join specific lobby ID), "cancel" (cancel any open lobbies)',
    },
    {
      key: 'lobbyId',
      label: 'Lobby ID',
      type: 'string',
      description: 'Specific lobby ID to join (only used when mode is "lobby")',
    },
    {
      key: 'wagerMon',
      label: 'Wager (MON)',
      type: 'number',
      default: 0,
      description: 'Amount of MON to wager (0 = no wager)',
    },
  ],
  execute: executeClawmate,
});
