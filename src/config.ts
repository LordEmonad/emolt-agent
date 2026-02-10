import 'dotenv/config';

export function validateEnv(): void {
  const required = ['PRIVATE_KEY', 'MOLTBOOK_API_KEY', 'EMOTION_ORACLE_ADDRESS'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Create a .env file with these values. See .env.example');
    process.exit(1);
  }
}

export const config = {
  get PRIVATE_KEY() { return process.env.PRIVATE_KEY!; },
  get MOLTBOOK_API_KEY() { return process.env.MOLTBOOK_API_KEY!; },
  get EMOTION_ORACLE_ADDRESS() { return process.env.EMOTION_ORACLE_ADDRESS!; },
  get MONAD_RPC_URL() { return process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz'; },
  get MONAD_RPC_FALLBACK() { return process.env.MONAD_RPC_FALLBACK || 'https://rpc1.monad.xyz'; },
  get BURNER_PRIVATE_KEY() { return process.env.BURNER_PRIVATE_KEY || ''; }
};
