import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';

function looksLikeHexKey(value) {
  const normalized = String(value || '').trim().replace(/^0x/, '');
  return /^[0-9a-fA-F]{64}$/.test(normalized);
}

function decodeSolanaSecretKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('WALLET_PRIVATE_KEY required');

  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    const bytes = Uint8Array.from(parsed);
    if (bytes.length !== 64) throw new Error('solana_secret_key_must_be_64_bytes');
    return bytes;
  }

  try {
    const decoded = bs58.decode(raw);
    if (decoded.length === 64) return Uint8Array.from(decoded);
  } catch {
    // ignore
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 64) return Uint8Array.from(decoded);
  } catch {
    // ignore
  }

  throw new Error('invalid_solana_private_key_encoding');
}

export function getWalletMaterial() {
  const raw = (process.env.WALLET_PRIVATE_KEY || '').trim();
  if (!raw) throw new Error('WALLET_PRIVATE_KEY required');

  if (looksLikeHexKey(raw)) {
    const hexKey = raw.startsWith('0x') ? raw : `0x${raw}`;
    const evmAccount = privateKeyToAccount(hexKey);
    return {
      family: 'evm',
      address: evmAccount.address,
      evmAccount,
      privateKeyHex: hexKey,
    };
  }

  const secretKey = decodeSolanaSecretKey(raw);
  const solanaKeypair = Keypair.fromSecretKey(secretKey);
  return {
    family: 'solana',
    address: solanaKeypair.publicKey.toBase58(),
    solanaKeypair,
    solanaPublicKey: solanaKeypair.publicKey,
  };
}

export function inferWalletFamilyFromAddress(address) {
  const normalized = String(address || '').trim();
  if (!normalized) return '';
  if (normalized.startsWith('0x') && normalized.length === 42) return 'evm';
  return 'solana';
}

export function requireWalletFamily(material, family) {
  if (material.family !== family) {
    throw new Error(`wallet_family_mismatch: expected ${family}, got ${material.family}`);
  }
}

export function resolveRequestedAddress(material, requestedAddress = '') {
  const normalized = String(requestedAddress || '').trim();
  if (!normalized) return material.address;
  const same = material.family === 'evm'
    ? normalized.toLowerCase() === material.address.toLowerCase()
    : normalized === material.address;
  if (!same) throw new Error(`wallet_address_mismatch: requested ${normalized}, derived ${material.address}`);
  return normalized;
}

export async function signAuthPayload(material, typedData) {
  if (typedData?.kind === 'solana_sign_message') {
    requireWalletFamily(material, 'solana');
    const messageBase64 = String(typedData.messageBase64 || '').trim();
    if (!messageBase64) throw new Error('solana_messageBase64_missing');
    const message = Buffer.from(messageBase64, 'base64');
    const signature = nacl.sign.detached(message, material.solanaKeypair.secretKey);
    return bs58.encode(signature);
  }

  requireWalletFamily(material, 'evm');
  const { EIP712Domain: _domain, ...types } = typedData.types || {};
  return material.evmAccount.signTypedData({
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}
