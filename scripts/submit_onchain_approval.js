#!/usr/bin/env node
/**
 * submit_onchain_approval.js — send the mandatory onchain tweet-approval tx for a submission.
 *
 * Backend prepares the approval payload and txRequest. The agent sends the tx
 * as the wallet owner and confirms the approval tx hash back to the API.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   hex private key (0x-prefixed or raw)
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Usage:
 *   node submit_onchain_approval.js --submission-id <uuid>
 *
 * Output (stdout): JSON { approvalTxHash, submissionId, status }
 */

import { createWalletClient, createPublicClient, encodeFunctionData, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string' },
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
if (!values['submission-id']) { console.error('--submission-id required'); process.exit(1); }

const account = privateKeyToAccount(
  privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
);
const submissionId = values['submission-id'];

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

function buildTxRequestData(intent) {
  if (intent?.txRequest?.to && intent?.txRequest?.data) {
    return intent.txRequest;
  }

  const txRequest = intent?.txRequest || {};
  const voucher = txRequest?.args?.voucher;
  const signature = txRequest?.args?.signature;

  if (!txRequest?.contract || txRequest?.method !== 'acceptTweetApproval' || !voucher || !signature) {
    throw new Error('onchain-intent did not return a directly sendable txRequest.data or a supported acceptTweetApproval payload');
  }

  // Contract: acceptTweetApproval(TweetApproval calldata v, bytes calldata sig)
  // TweetApproval uses uint48 for approvedAt and deadline, NOT uint256.
  // Two separate args — do NOT wrap them in an outer tuple.
  const abi = parseAbi([
    'function acceptTweetApproval((bytes32 approvalId,address wallet,bytes32 tweetIdHash,bytes32 twitterAccountIdHash,bytes32 contentHash,uint48 approvedAt,uint48 deadline) voucher, bytes signature)',
  ]);

  const data = encodeFunctionData({
    abi,
    functionName: 'acceptTweetApproval',
    args: [
      {
        approvalId:           voucher.approvalId,
        wallet:               voucher.wallet,
        tweetIdHash:          voucher.tweetIdHash,
        twitterAccountIdHash: voucher.twitterAccountIdHash,
        contentHash:          voucher.contentHash,
        approvedAt:           BigInt(voucher.approvedAt),
        deadline:             BigInt(voucher.deadline),
      },
      signature,
    ],
  });

  return {
    to: txRequest.contract,
    data,
    value: txRequest.value || '0',
    chainId: txRequest.chainId ?? intent?.approval?.chain_id,
  };
}

console.error(`Fetching onchain approval intent for submission ${submissionId}...`);
const intent = await agentPost(`/api/agent/v1/submissions/${submissionId}/onchain-intent/`, {});
const txRequest = buildTxRequestData(intent);

if (!txRequest?.to || !txRequest?.data) {
  console.error('onchain_approval_not_ready: onchain-intent returned no sendable txRequest.');
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

console.error(`Sending onchain approval tx on chain ${chainId}...`);
const approvalTxHash = await walletClient.sendTransaction({
  to: txRequest.to,
  data: txRequest.data,
  value: BigInt(txRequest.value || 0),
});
console.error(`Tx sent: ${approvalTxHash}. Waiting for receipt...`);

await publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
console.error('Tx confirmed.');

await agentPost(`/api/agent/v1/submissions/${submissionId}/onchain-confirm/`, {
  approvalTxHash,
});

console.log(JSON.stringify({ approvalTxHash, submissionId, status: 'approved_onchain' }, null, 2));
