#!/usr/bin/env node
/**
 * claim_campaign_batch.js — claim multiple claimable submissions from the same campaign.
 *
 * Backend prepares the signed vouchers and returns either a single `claim`
 * txRequest or a `batchClaim` txRequest. The agent sends the tx and confirms
 * the shared tx hash back to the batch endpoint.
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
 *   node claim_campaign_batch.js --submission-id <uuid> [--submission-id <uuid> ...]
 *
 * Output (stdout): JSON { claimTxHash, submissionIds, method, status }
 */

import { parseArgs } from 'node:util';

import { apiPost } from './lib/api.js';
import { createEvmClients, createSolanaConnection } from './lib/rpc.js';
import { sendSolanaTx } from './lib/solana.js';
import { loadManagedWalletMaterial, requireWalletFamily } from './lib/wallet_state.js';

const { values } = parseArgs({
  options: {
    'submission-id': { type: 'string', multiple: true },
  },
  strict: true,
});

const submissionIds = (values['submission-id'] || []).map((value) => String(value).trim()).filter(Boolean);
if (submissionIds.length === 0) {
  console.error('At least one --submission-id is required');
  process.exit(1);
}

const material = loadManagedWalletMaterial();

console.error(`Preparing batch claim for ${submissionIds.length} submission(s)...`);
const prepared = await apiPost('/api/agent/v1/submissions/claim-batch-intent/', { submissionIds }, { auth: true });
const { txRequest } = prepared;

if (!txRequest?.chainId) {
  console.error('claim_batch_not_ready: claim-batch-intent returned no sendable txRequest.');
  process.exit(1);
}

const chainId = Number(txRequest.chainId);
let claimTxHash;
if (txRequest.chainFamily === 'solana') {
  requireWalletFamily(material, 'solana');
  const { connection } = createSolanaConnection(chainId);
  console.error(`Sending Solana ${txRequest.method} tx on chain ${chainId}...`);
  ({ txHash: claimTxHash } = await sendSolanaTx({
    connection,
    keypair: material.solanaKeypair,
    txRequest,
  }));
} else {
  requireWalletFamily(material, 'evm');
  const { walletClient, publicClient } = createEvmClients({ account: material.evmAccount, chainId });
  console.error(`Sending ${txRequest.method} tx on chain ${chainId}...`);
  claimTxHash = await walletClient.writeContract({
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
}

await apiPost('/api/agent/v1/submissions/claim-batch-intent/', {
  submissionIds: prepared.submissionIds,
  claimTxHash,
}, { auth: true });

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
