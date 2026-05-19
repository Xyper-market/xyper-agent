import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
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
  const walletState = {
    version: 1,
    kind: 'agent-managed-evm-wallet',
    createdAt: new Date().toISOString(),
    accountIndex,
    derivationPath,
    address: account.address,
    privateKey,
    mnemonic,
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
  if (!parsed?.privateKey || !parsed?.address) {
    throw new Error(`Managed wallet state at ${resolvedStatePath} is missing address/privateKey fields.`);
  }

  return { walletState: parsed, resolvedStatePath };
}

export function loadManagedWalletAccount(explicitPath = '') {
  const { walletState, resolvedStatePath } = loadWalletState(explicitPath);
  const normalizedPrivateKey = walletState.privateKey.startsWith('0x')
    ? walletState.privateKey
    : `0x${walletState.privateKey}`;
  const account = privateKeyToAccount(normalizedPrivateKey);

  return { walletState, resolvedStatePath, account };
}
