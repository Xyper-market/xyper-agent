#!/usr/bin/env node
/**
 * claim_all_campaigns.js — claim multiple claimable submissions across campaigns on one chain.
 *
 * Backend groups the selected submissions by campaign and returns one txRequest
 * per group. The helper sends each tx sequentially and then confirms all
 * groups back to the backend in one request.
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
 *   node claim_all_campaigns.js --submission-id <uuid> [--submission-id <uuid> ...]
 *
 * Output (stdout): JSON { chainId, groups, status }
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { parseArgs } from 'node:util';

import { loadManagedWalletAccount } from './lib/wallet_state.js';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string', multiple: true },
  },
  strict: true,
});

const apiBase = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
const agentToken = (process.env.XYPER_AGENT_TOKEN || '').trim();
const rpcUrls = (process.env.RPC_URLS || '').trim();

if (!apiBase) { console.error('XYPER_API_BASE required'); process.exit(1); }
if (!agentToken) { console.error('XYPER_AGENT_TOKEN required'); process.exit(1); }
if (!rpcUrls) { console.error('RPC_URLS required'); process.exit(1); }

const submissionIds = (values['submission-id'] || []).map((value) => String(value).trim()).filter(Boolean);
if (submissionIds.length === 0) {
  console.error('At least one --submission-id is required');
  process.exit(1);
}

const { account } = loadManagedWalletAccount();

const authHeaders = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${agentToken}`,
};

async function agentPost(path, body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
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

console.error(`Preparing claim-all for ${submissionIds.length} submission(s)...`);
const prepared = await agentPost('/api/agent/v1/submissions/claim-all-intent/', { submissionIds });

if (!prepared?.groups?.length) {
  console.error('claim_all_not_ready: claim-all-intent returned no groups.');
  process.exit(1);
}

const chainId = Number(prepared.chainId);
const rpcUrl = resolveRpcUrl(chainId);

const chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

const abi = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'voucher',
        type: 'tuple',
        components: [
          { name: 'user', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'deadline', type: 'uint48' },
          { name: 'claimId', type: 'bytes32' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'batchClaim',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'vouchers',
        type: 'tuple[]',
        components: [
          { name: 'user', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'deadline', type: 'uint48' },
          { name: 'claimId', type: 'bytes32' },
        ],
      },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
];

const confirmations = [];
for (const group of prepared.groups) {
  const txRequest = group.txRequest;
  console.error(`Sending ${txRequest.method} for campaign ${group.campaignId} on chain ${chainId}...`);
  const claimTxHash = await walletClient.writeContract({
    address: txRequest.contract,
    abi,
    functionName: txRequest.method,
    args: buildContractArgs(txRequest),
  });
  console.error(`Tx sent: ${claimTxHash}. Waiting for receipt...`);
  await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
  console.error(`Tx confirmed for campaign ${group.campaignId}.`);
  confirmations.push({
    submissionIds: group.submissionIds,
    claimTxHash,
  });
}

await agentPost('/api/agent/v1/submissions/claim-all-confirm/', {
  groups: confirmations,
});

console.log(JSON.stringify({
  chainId,
  groups: confirmations,
  status: 'claimed',
}, null, 2));

function buildContractArgs(txRequest) {
  if (txRequest.method === 'batchClaim') {
    return [
      (txRequest.args?.vouchers || []).map(normalizeVoucher),
      txRequest.args?.signatures || [],
    ];
  }
  return [
    normalizeVoucher(txRequest.args?.voucher || {}),
    txRequest.args?.signature,
  ];
}

function normalizeVoucher(voucher) {
  return {
    user: voucher.user,
    token: voucher.token,
    amount: BigInt(voucher.amount),
    deadline: BigInt(voucher.deadline),
    claimId: voucher.claimId,
  };
}
