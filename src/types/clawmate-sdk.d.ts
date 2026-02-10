declare module 'clawmate-sdk' {
  import { Signer } from 'ethers';
  import { EventEmitter } from 'events';

  interface Lobby {
    lobbyId: string;
    contractGameId: number | null;
    betAmount: string;
    player1Wallet: string | null;
    player2Wallet: string | null;
    fen: string;
    status: 'waiting' | 'playing' | 'finished' | 'cancelled';
    winner: string | null;
  }

  interface ClawmateClientOptions {
    baseUrl: string;
    signer: Signer;
  }

  interface CreateLobbyOptions {
    betAmountWei: string;
    contractGameId?: number | null;
  }

  interface JoinOrCreateOptions {
    betMon?: number;
    betWei?: string;
    contractAddress?: string;
  }

  class ClawmateClient extends EventEmitter {
    constructor(options: ClawmateClientOptions);
    connect(): Promise<void>;
    disconnect(): void;
    getLobbies(): Promise<Lobby[]>;
    getLiveGames(): Promise<Lobby[]>;
    getLobby(lobbyId: string): Promise<Lobby>;
    createLobby(opts: CreateLobbyOptions): Promise<Lobby>;
    joinLobby(lobbyId: string): Promise<{ ok: boolean; fen: string }>;
    joinOrCreateLobby(options?: JoinOrCreateOptions): Promise<{ lobby: Lobby; created: boolean }>;
    cancelLobby(lobbyId: string): Promise<{ ok: boolean }>;
    concede(lobbyId: string): Promise<{ ok: boolean; status: string; winner: string }>;
    timeout(lobbyId: string): Promise<{ ok: boolean; status: string; winner: string }>;
    getResult(lobbyId: string): Promise<{ status: string; winner: string; winnerAddress: string }>;
    health(): Promise<{ ok: true }>;
    status(): Promise<{ totalLobbies: number; openLobbies: number; byStatus: Record<string, number> }>;
    joinGame(lobbyId: string): void;
    leaveGame(lobbyId: string): void;
    makeMove(lobbyId: string, from: string, to: string, promotion?: string): void;
    offerDraw(lobbyId: string): void;
    acceptDraw(lobbyId: string): void;
    declineDraw(lobbyId: string): void;
    withdrawDraw(lobbyId: string): void;
    spectateGame(lobbyId: string): void;
    signer: Signer;
  }

  function monToWei(mon: number | string): string;
  function weiToMon(wei: string | bigint): string;

  export { ClawmateClient, monToWei, weiToMon };
}
