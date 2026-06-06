import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_STATE_PATH = resolve(SCRIPTS_DIR, '..', '.xyper-agent-wallet.json');
const DEFAULT_ACCOUNT_INDEX = 0;

export function getDerivationPath(accountIndex = DEFAULT_ACCOUNT_INDEX) {
  return `m/44'/60'/0'/0/${accountIndex}`;
}

export function resolveWalletStatePath(explicitPath = '') {
  const envPath = (process.env.XYPER_WALLET_STATE_PATH || '').trim();
  return resolve(explicitPath || envPath || DEFAULT_STATE_PATH);
}

export function walletStateExists(explicitPath = '') {
  return existsSync(resolveWalletStatePath(explicitPath));
}

export function generateManagedWallet({ statePath = '', accountIndex = DEFAULT_ACCOUNT_INDEX } = {}) {
  const resolvedStatePath = resolveWalletStatePath(statePath);
  const derivationPath = getDerivationPath(accountIndex);
  const mnemonic = generateMnemonic(wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(derivationPath);

  if (!child.privateKey) {
    throw new Error(`Failed to derive private key for ${derivationPath}`);
  }

  const privateKey = toHex(child.privateKey);
  const account = privateKeyToAccount(privateKey);
  const solanaKeypair = Keypair.generate();
  const walletState = {
    version: 2,
    kind: 'agent-managed-multi-chain-wallet',
    createdAt: new Date().toISOString(),
    accountIndex,
    derivationPath,
    mnemonic,
    evm: {
      address: account.address,
      privateKey,
    },
    solana: {
      address: solanaKeypair.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(solanaKeypair.secretKey),
    },
    // Backward-compatible aliases for older tooling that expects the EVM wallet at top level.
    address: account.address,
    privateKey,
  };

  mkdirSync(dirname(resolvedStatePath), { recursive: true });
  writeFileSync(resolvedStatePath, `${JSON.stringify(walletState, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(resolvedStatePath, 0o600);
  } catch {
    // Best effort only; some filesystems ignore chmod semantics.
  }

  return { walletState, resolvedStatePath };
}

export function loadWalletState(explicitPath = '') {
  const resolvedStatePath = resolveWalletStatePath(explicitPath);

  if (!existsSync(resolvedStatePath)) {
    throw new Error(
      `Managed wallet state not found at ${resolvedStatePath}. Generate one first with node scripts/wallet_helper.js generate.`,
    );
  }

  const parsed = JSON.parse(readFileSync(resolvedStatePath, 'utf8'));
  if (!parsed?.evm && parsed?.privateKey && parsed?.address) {
    parsed.evm = {
      address: parsed.address,
      privateKey: parsed.privateKey,
    };
  }
  if (!parsed?.evm?.privateKey || !parsed?.evm?.address) {
    throw new Error(`Managed wallet state at ${resolvedStatePath} is missing evm.address/evm.privateKey fields.`);
  }
  if (!parsed?.solana?.secretKeyBase58 || !parsed?.solana?.address) {
    throw new Error(
      `Managed wallet state at ${resolvedStatePath} is missing solana.address/solana.secretKeyBase58 fields. `
      + `Re-generate it with node scripts/wallet_helper.js generate --force.`,
    );
  }

  return { walletState: parsed, resolvedStatePath };
}

export function loadManagedWalletMaterial(explicitPath = '') {
  const { walletState, resolvedStatePath } = loadWalletState(explicitPath);
  const normalizedPrivateKey = walletState.evm.privateKey.startsWith('0x')
    ? walletState.evm.privateKey
    : `0x${walletState.evm.privateKey}`;
  const evmAccount = privateKeyToAccount(normalizedPrivateKey);
  const solanaSecretKey = bs58.decode(walletState.solana.secretKeyBase58);
  const solanaKeypair = Keypair.fromSecretKey(solanaSecretKey);

  return {
    walletState,
    resolvedStatePath,
    evmAccount,
    solanaKeypair,
    evmAddress: walletState.evm.address,
    solanaAddress: walletState.solana.address,
  };
}

export function inferWalletFamilyFromAddress(address) {
  const normalized = String(address || '').trim();
  if (!normalized) return '';
  if (normalized.startsWith('0x') && normalized.length === 42) return 'evm';
  return 'solana';
}

export function resolveRequestedAddress(material, requestedAddress = '') {
  const normalized = String(requestedAddress || '').trim();
  if (!normalized) return material.evmAddress;
  const family = inferWalletFamilyFromAddress(normalized);
  if (family === 'evm') {
    if (normalized.toLowerCase() !== material.evmAddress.toLowerCase()) {
      throw new Error(`wallet_address_mismatch: requested ${normalized}, managed ${material.evmAddress}`);
    }
    return normalized;
  }
  if (normalized !== material.solanaAddress) {
    throw new Error(`wallet_address_mismatch: requested ${normalized}, managed ${material.solanaAddress}`);
  }
  return normalized;
}

export function requireWalletFamily(material, family) {
  if (!['evm', 'solana'].includes(family)) {
    throw new Error(`unsupported_wallet_family:${family}`);
  }
  return family;
}

export async function signAuthPayload(material, typedData, requestedAddress = '') {
  const address = resolveRequestedAddress(material, requestedAddress);
  if (typedData?.kind === 'solana_sign_message') {
    const messageBase64 = String(typedData.messageBase64 || '').trim();
    if (!messageBase64) throw new Error('solana_messageBase64_missing');
    if (address !== material.solanaAddress) {
      throw new Error(`wallet_family_mismatch: expected solana managed address, got ${address}`);
    }
    const message = Buffer.from(messageBase64, 'base64');
    const signature = nacl.sign.detached(message, material.solanaKeypair.secretKey);
    return bs58.encode(signature);
  }

  const { EIP712Domain: _domain, ...types } = typedData.types || {};
  if (address.toLowerCase() !== material.evmAddress.toLowerCase()) {
    throw new Error(`wallet_family_mismatch: expected evm managed address, got ${address}`);
  }
  return material.evmAccount.signTypedData({
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}
