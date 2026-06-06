#!/usr/bin/env node
/**
 * wallet_auth.js — obtain an agentSessionToken by signing an auth challenge.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   EVM hex private key or Solana secret key
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *
 * Usage:
 *   node wallet_auth.js [--address 0x...|<base58>] --chain-id 88817|900001 [--referral-code ABC123]
 *
 * Output (stdout): JSON { agentSessionToken, expiresAt, user, wallet }
 */

import { parseArgs } from 'node:util';

import { apiPost } from './lib/api.js';
import { getWalletMaterial, resolveRequestedAddress, signAuthPayload } from './lib/wallet.js';

const { values } = parseArgs({
  options: {
    address:          { type: 'string' },
    'chain-id':       { type: 'string', default: '' },
    'referral-code':  { type: 'string', default: '' },
  },
  strict: true,
});

const material = getWalletMaterial();
const address = resolveRequestedAddress(material, values.address || '');

// 1. Request nonce challenge (purpose=agent is enforced server-side)
const nonceBody = { address };
if (values['chain-id']) nonceBody.chainId = Number(values['chain-id']);

console.error('Requesting nonce...');
const { nonce, typedData } = await apiPost('/api/agent/v1/auth/wallet/nonce/', nonceBody);

// 2. Sign challenge: EIP-712 for EVM or raw message for Solana
const signature = await signAuthPayload(material, typedData);

// 3. Verify signature and get session token
const verifyBody = { address, nonce, signature };
if (values['referral-code']) verifyBody.referralCode = values['referral-code'];

console.error('Verifying signature...');
const result = await apiPost('/api/agent/v1/auth/wallet/verify/', verifyBody);

console.log(JSON.stringify(result, null, 2));
