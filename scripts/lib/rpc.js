import { Connection } from '@solana/web3.js';
import { createPublicClient, createWalletClient, http } from 'viem';

export function resolveRpcUrl(chainId) {
  const rpcUrls = (process.env.RPC_URLS || '').trim();
  if (!rpcUrls) throw new Error('RPC_URLS required');

  try {
    const map = JSON.parse(rpcUrls);
    const url = map[String(chainId)];
    if (url) return url;
  } catch {
    // single URL format
  }
  if (rpcUrls.startsWith('http')) return rpcUrls;
  throw new Error(`No RPC URL configured for chainId ${chainId}. Set RPC_URLS as JSON map.`);
}

export function buildViemChain(chainId, rpcUrl) {
  return {
    id: Number(chainId),
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function createEvmClients({ account, chainId }) {
  const rpcUrl = resolveRpcUrl(chainId);
  const chain = buildViemChain(chainId, rpcUrl);
  return {
    rpcUrl,
    chain,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  };
}

export function createSolanaConnection(chainId) {
  const rpcUrl = resolveRpcUrl(chainId);
  return {
    rpcUrl,
    connection: new Connection(rpcUrl, 'confirmed'),
  };
}
