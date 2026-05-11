#!/usr/bin/env node
/**
 * wallet_auth.js — obtain an agentSessionToken by signing an EIP-712 wallet challenge.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY   hex private key (0x-prefixed or raw)
 *   XYPER_API_BASE       e.g. https://api.xyper.market
 *
 * Usage:
 *   node wallet_auth.js --address 0x... --chain-id 88817 [--referral-code ABC123]
 *
 * Output (stdout): JSON { agentSessionToken, expiresAt, user, wallet }
 */

import { privateKeyToAccount } from 'viem/accounts';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    address:          { type: 'string' },
    'chain-id':       { type: 'string', default: '' },
    'referral-code':  { type: 'string', default: '' },
  },
  strict: true,
});

const privateKey = (process.env.WALLET_PRIVATE_KEY || '').trim();
const apiBase    = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');

if (!privateKey)    { console.error('WALLET_PRIVATE_KEY env var required'); process.exit(1); }
if (!apiBase)       { console.error('XYPER_API_BASE env var required');     process.exit(1); }
if (!values.address){ console.error('--address required');                  process.exit(1); }

const account = privateKeyToAccount(
  privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
);

async function post(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

// 1. Request nonce challenge (purpose=agent is enforced server-side)
const nonceBody = { address: values.address };
if (values['chain-id']) nonceBody.chainId = Number(values['chain-id']);

console.error('Requesting nonce...');
const { nonce, typedData } = await post('/api/agent/v1/auth/wallet/nonce/', nonceBody);

// 2. Sign EIP-712 typed data
// viem requires EIP712Domain to be absent from the types object
const { EIP712Domain: _domain, ...types } = typedData.types;

const signature = await account.signTypedData({
  domain:      typedData.domain,
  types,
  primaryType: typedData.primaryType,
  message:     typedData.message,
});

// 3. Verify signature and get session token
const verifyBody = { address: values.address, nonce, signature };
if (values['referral-code']) verifyBody.referralCode = values['referral-code'];

console.error('Verifying signature...');
const result = await post('/api/agent/v1/auth/wallet/verify/', verifyBody);

console.log(JSON.stringify(result, null, 2));
