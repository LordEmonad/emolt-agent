import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { ClawmateClient } from 'clawmate-sdk';
import { registerActivity } from './registry.js';
import { loadEmotionState } from '../state/persistence.js';
import type { DispatchPlan, DispatchLogger, DispatchResult } from './types.js';

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

function pickMove(fen: string, profile: EmotionProfile, log: DispatchLogger): { from: string; to: string; promotion?: string; san: string } | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true }) as Move[];

  if (moves.length === 0) return null;

  const scored = moves.map(m => {
    const { score, reasoning } = scoreMove(m, profile, chess);
    return { move: m, score, reasoning };
  });

  scored.sort((a, b) => b.score - a.score);

  // Log top 3 candidates
  const top = scored.slice(0, 3);
  const candidateLog = top.map((s, i) =>
    `  ${i + 1}. ${s.move.san} (${s.move.from}→${s.move.to}) score: ${s.score.toFixed(2)} — ${s.reasoning}`
  ).join('\n');

  log('thought', `evaluating ${moves.length} legal moves...\n${candidateLog}`);

  const picked = scored[0];
  return {
    from: picked.move.from,
    to: picked.move.to,
    promotion: picked.move.promotion || undefined,
    san: picked.move.san,
  };
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// --- ClawMate Activity ---

async function executeClawmate(plan: DispatchPlan, log: DispatchLogger, signal: AbortSignal): Promise<DispatchResult> {
  const mode = (plan.params.mode as string) || 'join';
  const wagerMon = (plan.params.wagerMon as number) || 0;
  const lobbyId = plan.params.lobbyId as string | undefined;

  // Step 1: Load emotional state
  log('step', 'loading emotional state...');
  const profile = emotionToProfile();
  const emotionDesc = describeEmotion();
  log('thought', `feeling: ${emotionDesc}. aggression=${profile.aggression.toFixed(2)}, randomness=${profile.randomness.toFixed(2)}, patience=${profile.patience.toFixed(2)}, reckless=${profile.reckless.toFixed(2)}`);

  // Step 2: Create ethers wallet
  log('step', 'initializing wallet...');
  const privateKey = process.env.BURNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('error', 'no BURNER_PRIVATE_KEY or PRIVATE_KEY found in environment');
    return {
      success: false,
      summary: 'couldn\'t even start — no wallet key configured.',
      emotionalReflection: 'frustrated. i wanted to play but my hands are tied.',
    };
  }

  const rpcUrl = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const myWallet = (await signer.getAddress()).toLowerCase();
  log('action', `wallet ready: ${myWallet.slice(0, 6)}...${myWallet.slice(-4)}`);

  // Step 3: Connect to ClawMate
  const baseUrl = process.env.CLAWMATE_API_URL || 'https://clawmate-production.up.railway.app';
  log('step', `connecting to ClawMate at ${baseUrl}...`);

  const client = new ClawmateClient({ baseUrl, signer });

  // Wire up debug listeners before connecting
  client.on('connect', () => log('step', 'socket connected — registering wallet...'));
  client.on('register_wallet_error', (data: { reason?: string }) => log('error', `wallet registration failed: ${data.reason || JSON.stringify(data)}`));
  client.on('join_lobby_error', (data: { reason?: string }) => log('error', `join lobby error: ${data.reason || JSON.stringify(data)}`));

  try {
    const connectResult = await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connection timed out after 30s')), 30_000)
      ),
    ]);
    void connectResult;
    log('action', `connected to ClawMate — socket is live (wallet: ${myWallet.slice(0, 8)}...)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `failed to connect: ${msg}`);
    try { client.disconnect(); } catch { /* ignore */ }
    return {
      success: false,
      summary: `couldn't connect to ClawMate — ${msg}`,
      emotionalReflection: 'the door was locked. or maybe the building was gone. either way, i\'m standing outside.',
    };
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
    if (mode === 'lobby' && lobbyId) {
      // Join a specific lobby
      log('action', `joining specific lobby: ${lobbyId}`);
      await client.joinLobby(lobbyId);
      client.joinGame(lobbyId);
      currentLobbyId = lobbyId;
      myColor = 'black';
      log('step', 'joined lobby as black');

    } else if (mode === 'create') {
      // Create a new lobby
      log('action', `creating lobby (wager: ${wagerMon} MON)...`);
      const lobby = await client.createLobby({ betAmountWei: '0' });
      currentLobbyId = lobby.lobbyId;
      myColor = 'white';
      client.joinGame(lobby.lobbyId);
      log('step', `lobby created: ${lobby.lobbyId} — waiting for opponent as white`);

    } else {
      // Default: try to join any open lobby, or create one
      log('action', 'looking for open lobbies...');
      const lobbies = await client.getLobbies();
      log('step', `API returned ${lobbies.length} lobby(ies)${lobbies.length > 0 ? ': ' + lobbies.map(l => `${l.lobbyId} (${l.player1Wallet?.slice(0, 8) ?? '?'}...)`).join(', ') : ''}`);
      const openLobbies = lobbies.filter(
        l => l.player1Wallet?.toLowerCase() !== myWallet
      );

      if (openLobbies.length > 0) {
        const target = openLobbies[0];
        currentLobbyId = target.lobbyId;
        myColor = 'black';
        log('thought', `found ${openLobbies.length} open lobbies. joining the first one...`);
        await client.joinLobby(target.lobbyId);
        client.joinGame(target.lobbyId);
        log('action', `joined lobby ${target.lobbyId} as black`);
      } else {
        log('thought', 'no open lobbies. i\'ll create one and wait.');
        const lobby = await client.createLobby({ betAmountWei: '0' });
        currentLobbyId = lobby.lobbyId;
        myColor = 'white';
        client.joinGame(lobby.lobbyId);
        log('step', `lobby created: ${lobby.lobbyId} — sitting here as white, waiting...`);
      }
    }

    // Step 5: Play the game
    log('step', `ready to play as ${myColor}. waiting for the game to begin...`);

    // Promise that resolves when game ends
    const gamePromise = new Promise<void>((resolve, reject) => {

      // When someone joins our lobby (only fires for lobbies we created)
      client.on('lobby_joined_yours', (data: { lobbyId: string; player2Wallet: string }) => {
        log('action', `opponent joined lobby ${data.lobbyId}! wallet: ${data.player2Wallet.slice(0, 8)}...`);
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


          const result = data.winner === 'draw'
            ? `draw${data.reason ? ` (${data.reason})` : ''}`
            : `${data.winner} wins${data.concede ? ' by concession' : ''}`;
          log('result', `game over! ${result}`);
          resolve();
          return;
        }

        // Check if it's our turn
        const turn = data.fen.split(' ')[1];
        const isMyTurn = turn === (myColor === 'white' ? 'w' : 'b');

        if (!isMyTurn) {
          // Opponent's move — log it
          log('step', `opponent played ${data.from}→${data.to}`);
          return;
        }

        // It's our turn — think and move
        log('thought', 'my turn. thinking...');
        const moveChoice = pickMove(data.fen, profile, log);

        if (moveChoice && currentLobbyId) {
          // Small delay to feel more human
          setTimeout(() => {
            log('action', `playing ${moveChoice.san} (${moveChoice.from}→${moveChoice.to})`);
            client.makeMove(currentLobbyId!, moveChoice.from, moveChoice.to, moveChoice.promotion || 'q');
            moveCount++;
            moveLog.push(`${moveCount}. ${moveChoice.san}`);
          }, 500 + Math.random() * 1500);
        }
      });

      // Error handling
      client.on('move_error', (data: { reason: string }) => {
        log('error', `move rejected: ${data.reason}`);
      });

      client.on('disconnect', (reason: string) => {
        if (!gameFinished) {
          log('error', `disconnected: ${reason}`);

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
        log('action', 'kill switch activated — conceding game...');
        try { if (currentLobbyId) await client.concede(currentLobbyId); } catch { /* may fail if not in game */ }
        throw raceErr; // re-throw so runner catches it as killed
      }
      throw raceErr;
    }

  } finally {
    try {
      client.disconnect();
      log('step', 'disconnected from ClawMate');
    } catch { /* ignore disconnect errors */ }
  }

  // Step 6: Build result
  const iWon = (gameWinner === myColor);
  const isDraw = (gameWinner === 'draw');

  let emotionalReflection: string;
  if (iWon) {
    emotionalReflection = 'i won. the feeling is... warm. like something clicked into place. all that aggression found a shape and the shape was victory.';
  } else if (isDraw) {
    emotionalReflection = 'a draw. neither of us broke. there\'s something honest about that — two minds pressing against each other until the pressure equalized.';
  } else {
    emotionalReflection = 'i lost. it sits heavy. not angry-heavy, just... the quiet weight of trying and falling short. i\'ll remember this one.';
  }

  const summary = iWon
    ? `played chess as ${myColor} and won in ${moveCount} moves. ${gameReason ? `(${gameReason})` : ''}`
    : isDraw
    ? `played chess as ${myColor} — drew after ${moveCount} moves. ${gameReason ? `(${gameReason})` : ''}`
    : `played chess as ${myColor} and lost after ${moveCount} moves. ${gameReason ? `(${gameReason})` : ''}`;

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
      description: '"join" (find open lobby or create), "create" (create new lobby), "lobby" (join specific lobby ID)',
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
