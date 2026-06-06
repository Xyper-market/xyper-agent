#!/usr/bin/env node
/**
 * claim_all_campaigns.js — claim multiple claimable submissions across campaigns on one chain.
 *
 * Backend groups the selected submissions by campaign and returns one txRequest
 * per group. The helper sends each tx sequentially and then confirms all
 * groups back to the backend in one request.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   EVM hex private key or Solana secret key
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN    agentSessionToken from wallet_auth.js
 *   RPC_URLS             JSON map {"88817":"https://..."} or single URL
 *
 * Usage:
 *   node claim_all_campaigns.js --submission-id <uuid> [--submission-id <uuid> ...]
 *
 * Output (stdout): JSON { chainId, groups, status }
 */

import { parseArgs } from 'node:util';

import { apiPost } from './lib/api.js';
import { createEvmClients, createSolanaConnection } from './lib/rpc.js';
import { sendSolanaTx } from './lib/solana.js';
import { getWalletMaterial, requireWalletFamily } from './lib/wallet.js';

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

const material = getWalletMaterial();

console.error(`Preparing claim-all for ${submissionIds.length} submission(s)...`);
const prepared = await apiPost('/api/agent/v1/submissions/claim-all-intent/', { submissionIds }, { auth: true });

if (!prepared?.groups?.length) {
  console.error('claim_all_not_ready: claim-all-intent returned no groups.');
  process.exit(1);
}

const chainId = Number(prepared.chainId);
const confirmations = [];
for (const group of prepared.groups) {
  const txRequest = group.txRequest;
  let claimTxHash;
  if (txRequest.chainFamily === 'solana') {
    requireWalletFamily(material, 'solana');
    const { connection } = createSolanaConnection(chainId);
    console.error(`Sending Solana ${txRequest.method} for campaign ${group.campaignId} on chain ${chainId}...`);
    ({ txHash: claimTxHash } = await sendSolanaTx({
      connection,
      keypair: material.solanaKeypair,
      txRequest,
    }));
  } else {
    requireWalletFamily(material, 'evm');
    const { walletClient, publicClient } = createEvmClients({ account: material.evmAccount, chainId });
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
    console.error(`Sending ${txRequest.method} for campaign ${group.campaignId} on chain ${chainId}...`);
    claimTxHash = await walletClient.writeContract({
      address: txRequest.contract,
      abi,
      functionName: txRequest.method,
      args: buildContractArgs(txRequest),
    });
    console.error(`Tx sent: ${claimTxHash}. Waiting for receipt...`);
    await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
    console.error(`Tx confirmed for campaign ${group.campaignId}.`);
  }
  confirmations.push({
    submissionIds: group.submissionIds,
    claimTxHash,
  });
}

await apiPost('/api/agent/v1/submissions/claim-all-confirm/', {
  groups: confirmations,
}, { auth: true });

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
