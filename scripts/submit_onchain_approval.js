#!/usr/bin/env node
/**
 * submit_onchain_approval.js — send the mandatory onchain tweet-approval tx for a submission.
 *
 * Backend prepares the approval payload and txRequest. The agent sends the tx
 * as the wallet owner and confirms the approval tx hash back to the API.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   EVM hex private key or Solana secret key
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Usage:
 *   node submit_onchain_approval.js --submission-id <uuid>
 *
 * Output (stdout): JSON { approvalTxHash, submissionId, status }
 */

import { encodeFunctionData, parseAbi } from 'viem';
import { parseArgs } from 'node:util';

import { apiPost } from './lib/api.js';
import { createEvmClients, createSolanaConnection } from './lib/rpc.js';
import { sendSolanaTx } from './lib/solana.js';
import { getWalletMaterial, requireWalletFamily } from './lib/wallet.js';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string' },
  },
  strict: true,
});

if (!values['submission-id']) { console.error('--submission-id required'); process.exit(1); }

const material = getWalletMaterial();
const submissionId = values['submission-id'];

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
const intent = await apiPost(`/api/agent/v1/submissions/${submissionId}/onchain-intent/`, {}, { auth: true });
if (intent?.txRequest?.chainFamily === 'solana') {
  requireWalletFamily(material, 'solana');
  const chainId = Number(intent.txRequest.chainId ?? intent.chainId);
  const { connection } = createSolanaConnection(chainId);
  console.error(`Sending Solana onchain approval tx on chain ${chainId}...`);
  const { txHash: approvalTxHash } = await sendSolanaTx({
    connection,
    keypair: material.solanaKeypair,
    txRequest: intent.txRequest,
  });
  console.error(`Tx sent: ${approvalTxHash}.`);
  await apiPost(`/api/agent/v1/submissions/${submissionId}/onchain-confirm/`, {
    approvalTxHash,
  }, { auth: true });
  console.log(JSON.stringify({ approvalTxHash, submissionId, status: 'approved_onchain' }, null, 2));
  process.exit(0);
}

const txRequest = buildTxRequestData(intent);

if (!txRequest?.to || !txRequest?.data) {
  console.error('onchain_approval_not_ready: onchain-intent returned no sendable txRequest.');
  process.exit(1);
}

const chainId = Number(txRequest.chainId);
requireWalletFamily(material, 'evm');
const { walletClient, publicClient } = createEvmClients({ account: material.evmAccount, chainId });

console.error(`Sending onchain approval tx on chain ${chainId}...`);
const approvalTxHash = await walletClient.sendTransaction({
  to: txRequest.to,
  data: txRequest.data,
  value: BigInt(txRequest.value || 0),
});
console.error(`Tx sent: ${approvalTxHash}. Waiting for receipt...`);

await publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
console.error('Tx confirmed.');

await apiPost(`/api/agent/v1/submissions/${submissionId}/onchain-confirm/`, {
  approvalTxHash,
}, { auth: true });

console.log(JSON.stringify({ approvalTxHash, submissionId, status: 'approved_onchain' }, null, 2));
