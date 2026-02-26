import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  verifyDispatch,
  verifyDispatchSignature,
  validateDispatchPayload,
} from '../dispatch-verifier.js';

const subtle = webcrypto.subtle;

/** Generate a P-256 keypair for testing */
async function genKeyPair() {
  return subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
}

/** Export public key as JWK */
async function exportPub(key: webcrypto.CryptoKey): Promise<webcrypto.JsonWebKey> {
  return subtle.exportKey('jwk', key);
}

/** Sign a payload */
async function sign(privateKey: webcrypto.CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const data = new TextEncoder().encode(canonical);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePayload(overrides?: Partial<{ nodeId: string; projectId: string; machineId: string; nonce: string }>) {
  return {
    v: 1 as const,
    nodeId: overrides?.nodeId ?? 'node-1',
    projectId: overrides?.projectId ?? 'proj-1',
    machineId: overrides?.machineId ?? 'machine-1',
    timestamp: new Date().toISOString(),
    nonce: overrides?.nonce ?? webcrypto.randomUUID(),
  };
}

describe('dispatch-verifier multi-key', () => {
  it('verifies with a single key', async () => {
    const kp = await genKeyPair();
    const pub = await exportPub(kp.publicKey);
    const payload = makePayload();
    const sig = await sign(kp.privateKey, payload);

    const result = await verifyDispatch(
      pub,
      sig,
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1',
    );
    expect(result.valid).toBe(true);
  });

  it('verifies when correct key is in an array of multiple keys', async () => {
    const kp1 = await genKeyPair();
    const kp2 = await genKeyPair();
    const kp3 = await genKeyPair();
    const pub1 = await exportPub(kp1.publicKey);
    const pub2 = await exportPub(kp2.publicKey);
    const pub3 = await exportPub(kp3.publicKey);

    // Sign with key 2
    const payload = makePayload();
    const sig = await sign(kp2.privateKey, payload);

    // Verify with array [key1, key2, key3] — should succeed (key2 matches)
    const result = await verifyDispatch(
      [pub1, pub2, pub3],
      sig,
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when no key in the array matches', async () => {
    const kp1 = await genKeyPair();
    const kp2 = await genKeyPair();
    const kpSigner = await genKeyPair();
    const pub1 = await exportPub(kp1.publicKey);
    const pub2 = await exportPub(kp2.publicKey);

    // Sign with a key NOT in the trusted array
    const payload = makePayload();
    const sig = await sign(kpSigner.privateKey, payload);

    const result = await verifyDispatch(
      [pub1, pub2],
      sig,
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('2 trusted keys');
  });

  it('rejects with empty key array', async () => {
    const kp = await genKeyPair();
    const payload = makePayload();
    const sig = await sign(kp.privateKey, payload);

    const result = await verifyDispatch(
      [],
      sig,
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('0 trusted keys');
  });

  it('rejects payload field mismatch before trying crypto', async () => {
    const kp = await genKeyPair();
    const pub = await exportPub(kp.publicKey);

    const payload = makePayload({ machineId: 'wrong-machine' });
    const sig = await sign(kp.privateKey, payload);

    const result = await verifyDispatch(
      [pub],
      sig,
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1', // expected machine doesn't match payload's 'wrong-machine'
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('machineId mismatch');
  });
});

describe('verifyDispatchSignature', () => {
  it('verifies a valid signature', async () => {
    const kp = await genKeyPair();
    const pub = await exportPub(kp.publicKey);
    const payload = makePayload();
    const sig = await sign(kp.privateKey, payload);

    const valid = await verifyDispatchSignature(pub, sig, payload);
    expect(valid).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const kp = await genKeyPair();
    const pub = await exportPub(kp.publicKey);
    const payload = makePayload();
    const sig = await sign(kp.privateKey, payload);

    const tampered = { ...payload, nodeId: 'tampered' };
    const valid = await verifyDispatchSignature(pub, sig, tampered);
    expect(valid).toBe(false);
  });
});

describe('validateDispatchPayload', () => {
  it('rejects stale timestamp', () => {
    const payload = makePayload();
    payload.timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago

    const result = validateDispatchPayload(
      payload,
      { planNodeId: 'node-1', projectId: 'proj-1' },
      'machine-1',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Timestamp');
  });
});
