#!/usr/bin/env node
/**
 * claim_campaign_batch.js — claim multiple claimable submissions from the same campaign.
 *
 * Backend prepares the signed vouchers and returns either a single `claim`
 * txRequest or a `batchClaim` txRequest. The agent sends the tx and confirms
 * the shared tx hash back to the batch endpoint.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   hex private key (0x-prefixed or raw)
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Usage:
 *   node claim_campaign_batch.js --submission-id <uuid> [--submission-id <uuid> ...]
 *
 * Output (stdout): JSON { claimTxHash, submissionIds, method, status }
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string', multiple: true },
  },
  strict: true,
});

const privateKey = (process.env.WALLET_PRIVATE_KEY || '').trim();
const apiBase = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
const agentToken = (process.env.XYPER_AGENT_TOKEN || '').trim();
const rpcUrls = (process.env.RPC_URLS || '').trim();

if (!privateKey) { console.error('WALLET_PRIVATE_KEY required'); process.exit(1); }
if (!apiBase) { console.error('XYPER_API_BASE required'); process.exit(1); }
if (!agentToken) { console.error('XYPER_AGENT_TOKEN required'); process.exit(1); }
if (!rpcUrls) { console.error('RPC_URLS required'); process.exit(1); }

const submissionIds = (values['submission-id'] || []).map((value) => String(value).trim()).filter(Boolean);
if (submissionIds.length === 0) {
  console.error('At least one --submission-id is required');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

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

console.error(`Preparing batch claim for ${submissionIds.length} submission(s)...`);
const prepared = await agentPost('/api/agent/v1/submissions/claim-batch-intent/', { submissionIds });
const { txRequest } = prepared;

if (!txRequest?.contract || !txRequest?.chainId) {
  console.error('claim_batch_not_ready: claim-batch-intent returned no sendable txRequest.');
  process.exit(1);
}

const chainId = Number(txRequest.chainId);
const rpcUrl = resolveRpcUrl(chainId);

const chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

console.error(`Sending ${txRequest.method} tx on chain ${chainId}...`);
const claimTxHash = await walletClient.writeContract({
  address: txRequest.contract,
  abi: [
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
  ],
  functionName: txRequest.method,
  args: buildContractArgs(txRequest),
});
console.error(`Tx sent: ${claimTxHash}. Waiting for receipt...`);

await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
console.error('Tx confirmed.');

await agentPost('/api/agent/v1/submissions/claim-batch-intent/', {
  submissionIds: prepared.submissionIds,
  claimTxHash,
});

console.log(JSON.stringify({
  claimTxHash,
  submissionIds: prepared.submissionIds,
  method: txRequest.method,
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
