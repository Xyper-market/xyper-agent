#!/usr/bin/env node
/**
 * claim_reward.js — claim a campaign submission reward.
 *
 * Backend signs the EIP-712 voucher (operator key). The agent just sends the
 * pre-built transaction and confirms the tx hash back to the API.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   EVM hex private key or Solana secret key
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Usage:
 *   node claim_reward.js --submission-id <uuid>
 *
 * Output (stdout): JSON { claimTxHash, status }
 */

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

if (!values['submission-id']) { console.error('--submission-id required');    process.exit(1); }

const material = getWalletMaterial();
const submissionId = values['submission-id'];

// 1. Get claim intent — backend returns a ready-to-send tx
console.error(`Fetching claim intent for submission ${submissionId}...`);
const claimIntent = await apiPost(`/api/agent/v1/submissions/${submissionId}/claim-intent/`, {}, { auth: true });
const { txRequest } = claimIntent;

if (txRequest?.chainFamily === 'solana') {
  requireWalletFamily(material, 'solana');
  const chainId = Number(txRequest.chainId ?? claimIntent.chainId);
  const { connection } = createSolanaConnection(chainId);
  console.error(`Sending Solana claim tx on chain ${chainId}...`);
  const { txHash } = await sendSolanaTx({
    connection,
    keypair: material.solanaKeypair,
    txRequest,
  });
  await apiPost(`/api/agent/v1/submissions/${submissionId}/claim-confirm/`, {
    claimTxHash: txHash,
  }, { auth: true });
  console.log(JSON.stringify({ claimTxHash: txHash, status: 'claimed' }, null, 2));
  process.exit(0);
}

if (!txRequest?.to || !txRequest?.data) {
  console.error('claim_not_ready: claim-intent returned no txRequest. Submission may not be claimable yet.');
  process.exit(1);
}

// 2. Resolve chain and RPC
const chainId = Number(txRequest.chainId);
requireWalletFamily(material, 'evm');
const { walletClient, publicClient } = createEvmClients({ account: material.evmAccount, chainId });

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
await apiPost(`/api/agent/v1/submissions/${submissionId}/claim-confirm/`, {
  claimTxHash: txHash,
}, { auth: true });

console.log(JSON.stringify({ claimTxHash: txHash, status: 'claimed' }, null, 2));
