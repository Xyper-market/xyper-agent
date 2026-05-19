#!/usr/bin/env node
/**
 * claim_reward.js — claim a campaign submission reward.
 *
 * Backend signs the EIP-712 voucher (operator key). The agent just sends the
 * pre-built transaction and confirms the tx hash back to the API.
 *
 * Required env vars:
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Required local state:
 *   managed wallet created by wallet_helper.js
 *
 * Usage:
 *   node claim_reward.js --submission-id <uuid>
 *
 * Output (stdout): JSON { claimTxHash, status }
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { parseArgs } from 'node:util';

import { loadManagedWalletAccount } from './lib/wallet_state.js';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string' },
  },
  strict: true,
});

const apiBase     = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
const agentToken  = (process.env.XYPER_AGENT_TOKEN || '').trim();
const rpcUrls     = (process.env.RPC_URLS || '').trim();

if (!apiBase)                 { console.error('XYPER_API_BASE required');     process.exit(1); }
if (!agentToken)              { console.error('XYPER_AGENT_TOKEN required');  process.exit(1); }
if (!rpcUrls)                 { console.error('RPC_URLS required');           process.exit(1); }
if (!values['submission-id']) { console.error('--submission-id required');    process.exit(1); }

const { account } = loadManagedWalletAccount();
const submissionId = values['submission-id'];

const authHeaders = {
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${agentToken}`,
};

async function agentPost(path, body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method:  'POST',
    headers: authHeaders,
    body:    JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

function resolveRpcUrl(chainId) {
  try {
    const map = JSON.parse(rpcUrls);
    const url = map[String(chainId)];
    if (url) return url;
  } catch { /* single URL format */ }
  if (rpcUrls.startsWith('http')) return rpcUrls;
  throw new Error(`No RPC URL configured for chainId ${chainId}. Set RPC_URLS as JSON map.`);
}

// 1. Get claim intent — backend returns a ready-to-send tx
console.error(`Fetching claim intent for submission ${submissionId}...`);
const claimIntent = await agentPost(`/api/agent/v1/submissions/${submissionId}/claim-intent/`);
const { txRequest } = claimIntent;

if (!txRequest?.to || !txRequest?.data) {
  console.error('claim_not_ready: claim-intent returned no txRequest. Submission may not be claimable yet.');
  process.exit(1);
}

// 2. Resolve chain and RPC
const chainId = Number(txRequest.chainId);
const rpcUrl  = resolveRpcUrl(chainId);

// Minimal chain definition — viem needs at least id + rpcUrls
const chain = {
  id:             chainId,
  name:           `chain-${chainId}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls:        { default: { http: [rpcUrl] } },
};

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

// 3. Send the pre-built claim transaction
console.error(`Sending claim tx on chain ${chainId}...`);
const txHash = await walletClient.sendTransaction({
  to:    txRequest.to,
  data:  txRequest.data,
  value: BigInt(txRequest.value || 0),
});
console.error(`Tx sent: ${txHash}. Waiting for receipt...`);

// 4. Wait for confirmation
await publicClient.waitForTransactionReceipt({ hash: txHash });
console.error('Tx confirmed.');

// 5. Tell the backend
await agentPost(`/api/agent/v1/submissions/${submissionId}/claim-confirm/`, {
  claimTxHash: txHash,
});

console.log(JSON.stringify({ claimTxHash: txHash, status: 'claimed' }, null, 2));
