#!/usr/bin/env node
/**
 * claim_referral_reward.js — claim all claimable referral rewards in a single batched tx.
 *
 * Backend signs the batched voucher. The agent sends the pre-built transaction
 * and confirms the tx hash back to the API.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   hex private key (0x-prefixed or raw)
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Optional:
 *   WALLET_ADDRESS       if not inferrable from private key (normally not needed)
 *
 * Usage:
 *   node claim_referral_reward.js [--wallet-address 0x...]
 *
 * Output (stdout): JSON { claimTxHash, rewardIds, status } | { status: "nothing_to_claim" }
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'wallet-address': { type: 'string', default: '' },
  },
  strict: true,
});

const privateKey  = (process.env.WALLET_PRIVATE_KEY || '').trim();
const apiBase     = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
const agentToken  = (process.env.XYPER_AGENT_TOKEN || '').trim();
const rpcUrls     = (process.env.RPC_URLS || '').trim();

if (!privateKey)  { console.error('WALLET_PRIVATE_KEY required'); process.exit(1); }
if (!apiBase)     { console.error('XYPER_API_BASE required');     process.exit(1); }
if (!agentToken)  { console.error('XYPER_AGENT_TOKEN required');  process.exit(1); }
if (!rpcUrls)     { console.error('RPC_URLS required');           process.exit(1); }

const account = privateKeyToAccount(
  privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
);
const walletAddress = (values['wallet-address'] || account.address).toLowerCase();

const authHeaders = {
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${agentToken}`,
};

async function agentGet(path) {
  const res = await fetch(`${apiBase}${path}`, { headers: authHeaders });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

async function agentPost(path, body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method:  'POST',
    headers: authHeaders,
    body:    JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

function resolveRpcUrl(chainId) {
  try {
    const map = JSON.parse(rpcUrls);
    const url = map[String(chainId)];
    if (url) return url;
  } catch { /* single URL */ }
  if (rpcUrls.startsWith('http')) return rpcUrls;
  throw new Error(`No RPC URL configured for chainId ${chainId}. Set RPC_URLS as JSON map.`);
}

// 1. Check for claimable referral rewards
console.error('Checking referral rewards...');
const rewardsData = await agentGet('/api/agent/v1/me/referral/rewards/');
const rewards = rewardsData.results ?? rewardsData;
const claimable = rewards.filter(r => r.claimable);

if (claimable.length === 0) {
  console.log(JSON.stringify({ status: 'nothing_to_claim' }, null, 2));
  process.exit(0);
}
console.error(`Found ${claimable.length} claimable referral reward(s).`);

// 2. Get batched claim intent — backend builds and signs the batched voucher
const claimIntent = await agentPost('/api/agent/v1/me/referral/claim-intent/', {
  walletAddress,
});
const { txRequest, rewardIds } = claimIntent;

if (!txRequest?.to || !txRequest?.data) {
  console.error('no_claimable_referral_rewards: claim-intent returned no txRequest.');
  process.exit(1);
}

// 3. Resolve chain and RPC
const chainId = Number(txRequest.chainId);
const rpcUrl  = resolveRpcUrl(chainId);

const chain = {
  id:             chainId,
  name:           `chain-${chainId}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls:        { default: { http: [rpcUrl] } },
};

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

// 4. Send tx
console.error(`Sending referral claim tx on chain ${chainId}...`);
const txHash = await walletClient.sendTransaction({
  to:    txRequest.to,
  data:  txRequest.data,
  value: BigInt(txRequest.value || 0),
});
console.error(`Tx sent: ${txHash}. Waiting for receipt...`);

await publicClient.waitForTransactionReceipt({ hash: txHash });
console.error('Tx confirmed.');

// 5. Confirm to backend
await agentPost('/api/agent/v1/me/referral/claim-confirm/', {
  claimTxHash: txHash,
});

console.log(JSON.stringify({ claimTxHash: txHash, rewardIds, status: 'claimed' }, null, 2));
