import { createPublicClient, createWalletClient, http, fallback, defineChain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Define Monad chain (may not be in viem/chains yet)
export const monad = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] }
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://monadscan.com' }
  }
});

// Ordered RPC endpoints (primary + fallback) per ChainMMO /meta/rpc recommendation
const rpcUrl = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const rpcFallback = process.env.MONAD_RPC_FALLBACK || 'https://monad-mainnet.api.onfinality.io/public';

const rpcTransport: Transport = fallback([
  http(rpcUrl),
  http(rpcFallback),
]);

export const publicClient = createPublicClient({
  chain: monad,
  transport: rpcTransport,
});

export function getWalletClient() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: monad,
    transport: rpcTransport,
  });
}

export function getAccount() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  return privateKeyToAccount(privateKey);
}
