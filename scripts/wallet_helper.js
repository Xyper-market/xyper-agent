#!/usr/bin/env node
/**
 * wallet_helper.js — manage the skill-owned EVM + Solana wallet set used by xyper-agent.
 *
 * Commands:
 *   generate [--account-index 0] [--state-path /path/to/wallet.json] [--force]
 *   inspect  [--state-path /path/to/wallet.json]
 *   export   --secret private-key|mnemonic|all [--state-path /path/to/wallet.json]
 *
 * This helper intentionally stores secrets on disk inside a local state file
 * rather than requiring a wallet private key in environment variables.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  generateManagedWallet,
  getDerivationPath,
  loadWalletState,
  resolveWalletStatePath,
} from './lib/wallet_state.js';

const [, , command = 'inspect', ...rest] = process.argv;

const { values } = parseArgs({
  args: rest,
  options: {
    'state-path': { type: 'string', default: '' },
    'account-index': { type: 'string', default: '0' },
    secret: { type: 'string', default: '' },
    force: { type: 'boolean', default: false },
  },
  strict: true,
});

const statePath = resolveWalletStatePath(values['state-path']);

function parseAccountIndex(rawValue) {
  const accountIndex = Number(rawValue);
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid --account-index value: ${rawValue}`);
  }
  return accountIndex;
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

try {
  if (command === 'generate') {
    const accountIndex = parseAccountIndex(values['account-index']);
    if (existsSync(statePath) && !values.force) {
      throw new Error(
        `Managed wallet state already exists at ${statePath}. Use inspect/export, or pass --force to replace it.`,
      );
    }

    if (existsSync(statePath) && values.force) {
      unlinkSync(statePath);
    }

    const { walletState, resolvedStatePath } = generateManagedWallet({ statePath, accountIndex });
    printJson({
      status: 'generated',
      address: walletState.evm.address,
      evmAddress: walletState.evm.address,
      solanaAddress: walletState.solana.address,
      accountIndex: walletState.accountIndex,
      derivationPath: walletState.derivationPath,
      statePath: resolvedStatePath,
      nextStep: 'Fund the EVM and/or Solana address with native gas before wallet_auth or onchain actions.',
      secretExport: [
        'node scripts/wallet_helper.js export --secret private-key',
        'node scripts/wallet_helper.js export --secret mnemonic',
        'node scripts/wallet_helper.js export --secret solana-secret-key',
      ],
    });
  } else if (command === 'inspect') {
    const { walletState, resolvedStatePath } = loadWalletState(statePath);
    printJson({
      status: 'ready',
      address: walletState.evm.address,
      evmAddress: walletState.evm.address,
      solanaAddress: walletState.solana.address,
      accountIndex: walletState.accountIndex,
      derivationPath: walletState.derivationPath || getDerivationPath(walletState.accountIndex || 0),
      createdAt: walletState.createdAt,
      statePath: resolvedStatePath,
    });
  } else if (command === 'export') {
    const { walletState, resolvedStatePath } = loadWalletState(statePath);
    const secret = (values.secret || '').trim();

    if (!['private-key', 'mnemonic', 'solana-secret-key', 'all'].includes(secret)) {
      throw new Error(`--secret must be one of: private-key, mnemonic, solana-secret-key, all`);
    }

    const payload = {
      status: 'exported',
      statePath: resolvedStatePath,
      address: walletState.evm.address,
      evmAddress: walletState.evm.address,
      solanaAddress: walletState.solana.address,
    };

    if (secret === 'private-key' || secret === 'all') {
      payload.privateKey = walletState.evm.privateKey;
    }
    if (secret === 'mnemonic' || secret === 'all') {
      payload.mnemonic = walletState.mnemonic;
    }
    if (secret === 'solana-secret-key' || secret === 'all') {
      payload.solanaSecretKeyBase58 = walletState.solana.secretKeyBase58;
    }
    if (secret === 'all') {
      payload.accountIndex = walletState.accountIndex;
      payload.derivationPath = walletState.derivationPath;
    }

    printJson(payload);
  } else {
    throw new Error(`Unknown command: ${command}. Use generate, inspect, or export.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
