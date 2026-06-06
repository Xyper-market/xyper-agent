import { createHash } from 'node:crypto';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const METHOD_DISCRIMINATORS = {
  acceptSubmissionApproval: discriminator('global:accept_submission_approval'),
  claim: discriminator('global:claim'),
  batchClaim: discriminator('global:batch_claim'),
};

function discriminator(name) {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

function decodeHex32(value) {
  const normalized = String(value || '').trim().replace(/^0x/, '').toLowerCase();
  if (normalized.length !== 64) throw new Error('solana_hex32_must_be_32_bytes');
  return Buffer.from(normalized, 'hex');
}

function pubkeyBytes(value) {
  return new PublicKey(String(value || '').trim()).toBuffer();
}

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(String(value)));
  return buf;
}

function i64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(String(value)));
  return buf;
}

function u16le(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(Number(value));
  return buf;
}

function fixed64Signature(signatureLike) {
  const bytes = Array.isArray(signatureLike)
    ? Uint8Array.from(signatureLike.map((item) => Number(item)))
    : Uint8Array.from(signatureLike || []);
  if (bytes.length !== 64) throw new Error('solana_backend_signature_must_be_64_bytes');
  return Buffer.from(bytes);
}

function serializeApprovalPayload(payload) {
  return Buffer.concat([
    pubkeyBytes(payload.campaign),
    Buffer.from(payload.approvalId),
    pubkeyBytes(payload.wallet),
    Buffer.from(payload.tweetIdHash),
    Buffer.from(payload.xAccountIdHash),
    Buffer.from(payload.contentHash),
    u64le(payload.scoreScaled),
    i64le(payload.approvedAtUnix),
    i64le(payload.deadlineUnix),
  ]);
}

function serializeClaimPayload(payload) {
  return Buffer.concat([
    pubkeyBytes(payload.campaign),
    Buffer.from(payload.claimId),
    pubkeyBytes(payload.user),
    pubkeyBytes(payload.tokenMint),
    u64le(payload.amount),
    i64le(payload.deadlineUnix),
  ]);
}

function serializeBatchClaimPayload(payload) {
  return Buffer.concat([
    pubkeyBytes(payload.campaign),
    Buffer.from(payload.batchId),
    pubkeyBytes(payload.user),
    pubkeyBytes(payload.tokenMint),
    u64le(payload.totalAmount),
    u16le(payload.claimCount),
    i64le(payload.deadlineUnix),
  ]);
}

function normalizeApprovalPayload(payload) {
  return {
    campaign: String(payload.campaign),
    approvalId: bytes32Buffer(payload.approvalId),
    wallet: String(payload.wallet),
    tweetIdHash: bytes32Buffer(payload.tweetIdHash),
    xAccountIdHash: bytes32Buffer(payload.xAccountIdHash),
    contentHash: bytes32Buffer(payload.contentHash),
    scoreScaled: payload.scoreScaled,
    approvedAtUnix: payload.approvedAtUnix,
    deadlineUnix: payload.deadlineUnix,
  };
}

function normalizeClaimPayload(payload) {
  return {
    campaign: String(payload.campaign),
    claimId: bytes32Buffer(payload.claimId),
    user: String(payload.user),
    tokenMint: String(payload.tokenMint),
    amount: payload.amount,
    deadlineUnix: payload.deadlineUnix,
  };
}

function normalizeBatchClaimPayload(payload) {
  return {
    campaign: String(payload.campaign),
    batchId: bytes32Buffer(payload.batchId),
    user: String(payload.user),
    tokenMint: String(payload.tokenMint),
    totalAmount: payload.totalAmount,
    claimCount: payload.claimCount,
    deadlineUnix: payload.deadlineUnix,
  };
}

function bytes32Buffer(value) {
  if (Array.isArray(value)) {
    const bytes = Uint8Array.from(value.map((item) => Number(item)));
    if (bytes.length !== 32) throw new Error('solana_bytes32_must_be_32_bytes');
    return Buffer.from(bytes);
  }
  return decodeHex32(value);
}

function approvalMessage(payload) {
  return Buffer.concat([Buffer.from('xyper:approval:'), serializeApprovalPayload(payload)]);
}

function claimMessage(payload) {
  return Buffer.concat([Buffer.from('xyper:claim:'), serializeClaimPayload(payload)]);
}

function batchClaimMessage(payload) {
  return Buffer.concat([Buffer.from('xyper:batch-claim:'), serializeBatchClaimPayload(payload)]);
}

function approvalRecordPda(programId, campaign, approvalId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('approval-record'), new PublicKey(campaign).toBuffer(), Buffer.from(approvalId)],
    new PublicKey(programId)
  )[0];
}

function claimRecordPda(programId, campaign, claimId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim-record'), new PublicKey(campaign).toBuffer(), Buffer.from(claimId)],
    new PublicKey(programId)
  )[0];
}

function batchClaimRecordPda(programId, campaign, batchId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('batch-claim-record'), new PublicKey(campaign).toBuffer(), Buffer.from(batchId)],
    new PublicKey(programId)
  )[0];
}

export async function sendSolanaTx({ connection, keypair, txRequest }) {
  const method = String(txRequest?.method || '').trim();
  const programId = new PublicKey(String(txRequest?.programId || '').trim());
  const backendSignature = fixed64Signature(txRequest?.args?.backendSignature);

  if (method === 'acceptSubmissionApproval') {
    const payload = normalizeApprovalPayload(txRequest?.args?.payload || {});
    const message = approvalMessage(payload);
    const verifyIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: pubkeyBytes(txRequest?.meta?.backendSigner),
      message,
      signature: backendSignature,
    });
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(payload.campaign), isSigner: false, isWritable: true },
        { pubkey: approvalRecordPda(programId, payload.campaign, payload.approvalId), isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([METHOD_DISCRIMINATORS.acceptSubmissionApproval, serializeApprovalPayload(payload), backendSignature]),
    });
    const tx = new Transaction().add(verifyIx, instruction);
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    return { txHash: signature };
  }

  if (method === 'claim' || method === 'batchClaim') {
    const payload = method === 'claim'
      ? normalizeClaimPayload(txRequest?.args?.payload || {})
      : normalizeBatchClaimPayload(txRequest?.args?.payload || {});
    const message = method === 'claim' ? claimMessage(payload) : batchClaimMessage(payload);
    const verifyIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: pubkeyBytes(txRequest?.meta?.backendSigner),
      message,
      signature: backendSignature,
    });

    const campaign = new PublicKey(payload.campaign);
    const tokenMint = new PublicKey(payload.tokenMint);
    const campaignVault = getAssociatedTokenAddressSync(tokenMint, campaign, true);
    const userTokenAccount = getAssociatedTokenAddressSync(tokenMint, keypair.publicKey, false);
    const ensureAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      userTokenAccount,
      keypair.publicKey,
      tokenMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const recordPubkey = method === 'claim'
      ? claimRecordPda(programId, payload.campaign, payload.claimId)
      : batchClaimRecordPda(programId, payload.campaign, payload.batchId);
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: campaign, isSigner: false, isWritable: true },
        { pubkey: campaignVault, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: recordPubkey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        METHOD_DISCRIMINATORS[method],
        method === 'claim' ? serializeClaimPayload(payload) : serializeBatchClaimPayload(payload),
        backendSignature,
      ]),
    });
    const tx = new Transaction().add(ensureAtaIx, verifyIx, instruction);
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    return { txHash: signature };
  }

  throw new Error(`unsupported_solana_method:${method}`);
}
