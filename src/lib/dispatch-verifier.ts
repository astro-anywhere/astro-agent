/**
 * Dispatch Signature Verifier
 *
 * Verifies ECDSA P-256 signatures on task dispatches to ensure they
 * originated from the user's browser, not from a compromised server.
 */

import { webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;
type CryptoKey = webcrypto.CryptoKey;

const subtle = webcrypto.subtle;

/** The payload that was signed by the user's browser */
interface DispatchSigningPayload {
  v: 1;
  nodeId: string;
  projectId: string;
  machineId: string;
  timestamp: string;
  nonce: string;
}

/** Result of dispatch verification */
export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/** Maximum age of a dispatch timestamp (5 minutes) */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/** Maximum nonce tracker age (10 minutes) */
const NONCE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Tracks used nonces to prevent replay attacks.
 * Nonces older than NONCE_MAX_AGE_MS are automatically pruned.
 */
class NonceTracker {
  private nonces = new Map<string, number>(); // nonce -> timestamp

  /**
   * Check if a nonce has been seen before and record it.
   * Returns true if the nonce is new (not a replay).
   */
  checkAndRecord(nonce: string): boolean {
    this.prune();
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, Date.now());
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - NONCE_MAX_AGE_MS;
    for (const [nonce, timestamp] of this.nonces) {
      if (timestamp < cutoff) this.nonces.delete(nonce);
    }
  }
}

const nonceTracker = new NonceTracker();

/**
 * Base64url decode (no padding).
 */
function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = Buffer.from(padded, 'base64');
  return new Uint8Array(binary);
}

/**
 * Deterministic JSON serialization matching the browser's canonicalization.
 */
function canonicalizePayload(payload: DispatchSigningPayload): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/**
 * Import a JWK public key for ECDSA P-256 verification.
 */
async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/**
 * Verify the cryptographic signature of a dispatch payload.
 */
export async function verifyDispatchSignature(
  publicKeyJwk: JsonWebKey,
  signature: string,
  payload: DispatchSigningPayload,
): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyJwk);
    const canonical = canonicalizePayload(payload);
    const data = new TextEncoder().encode(canonical);
    const sigBytes = base64urlDecode(signature);
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      data,
    );
  } catch (err) {
    console.error('[dispatch-verifier] Signature verification error:', err);
    return false;
  }
}

/**
 * Validate a dispatch payload against the expected task and machine.
 * Checks field matching, timestamp freshness, and nonce uniqueness.
 */
export function validateDispatchPayload(
  payload: DispatchSigningPayload,
  task: { planNodeId: string; projectId: string },
  machineId: string,
): VerifyResult {
  // Version check
  if (payload.v !== 1) {
    return { valid: false, reason: `Unknown payload version: ${payload.v}` };
  }

  // Field matching
  if (payload.nodeId !== task.planNodeId) {
    return { valid: false, reason: `nodeId mismatch: payload=${payload.nodeId}, task=${task.planNodeId}` };
  }
  if (payload.projectId !== task.projectId) {
    return { valid: false, reason: `projectId mismatch: payload=${payload.projectId}, task=${task.projectId}` };
  }
  if (payload.machineId !== machineId) {
    return { valid: false, reason: `machineId mismatch: payload=${payload.machineId}, expected=${machineId}` };
  }

  // Timestamp freshness
  const age = Date.now() - new Date(payload.timestamp).getTime();
  if (Math.abs(age) > MAX_TIMESTAMP_AGE_MS) {
    return { valid: false, reason: `Timestamp too old or in the future: ${payload.timestamp} (age: ${Math.round(age / 1000)}s)` };
  }

  // Nonce uniqueness
  if (!nonceTracker.checkAndRecord(payload.nonce)) {
    return { valid: false, reason: `Nonce replay detected: ${payload.nonce.slice(0, 16)}...` };
  }

  return { valid: true };
}

/**
 * Full dispatch verification: validate payload fields, then verify signature.
 * Accepts a single key or an array of trusted keys (any match = valid).
 */
export async function verifyDispatch(
  publicKeyJwk: JsonWebKey | JsonWebKey[],
  signature: string,
  payload: DispatchSigningPayload,
  task: { planNodeId: string; projectId: string },
  machineId: string,
): Promise<VerifyResult> {
  // First validate payload fields
  const fieldResult = validateDispatchPayload(payload, task, machineId);
  if (!fieldResult.valid) return fieldResult;

  // Try each trusted key — accept if any one matches
  const keys = Array.isArray(publicKeyJwk) ? publicKeyJwk : [publicKeyJwk];
  for (const key of keys) {
    const sigValid = await verifyDispatchSignature(key, signature, payload);
    if (sigValid) return { valid: true };
  }

  return { valid: false, reason: `Invalid cryptographic signature (tried ${keys.length} trusted key${keys.length === 1 ? '' : 's'})` };
}
