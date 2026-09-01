import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH,
  computeFiscalHash,
  verifyFiscalHash,
  verifyFiscalChain,
} from '../../src/utils/fiscalIntegrity';

describe('fiscalIntegrity unit tests', () => {
  const secret = 'test-secret-key-32-chars-long-aaa';

  const makeEntry = (seq: number, prev: string) => {
    const base = {
      sequenceNumber: seq,
      previousHash: prev,
      sessionId: `sess_${seq}`,
      timestamp: '2026-07-23T20:00:00.000Z',
      printerBrand: 'ACUBE',
      commandPayload: JSON.stringify({ items: [{ title: 'Drink', priceCents: 1000 }] }),
      statusResponse: JSON.stringify({ docId: `doc_${seq}` }),
      success: true,
      errorMessage: null,
    };
    const hash = computeFiscalHash(base, secret);
    return { ...base, hash };
  };

  it('generates deterministic GENESIS_HASH', () => {
    expect(GENESIS_HASH).toBeDefined();
    expect(typeof GENESIS_HASH).toBe('string');
    expect(GENESIS_HASH.length).toBe(64);
  });

  it('computes deterministic fiscal hash and verifies it', () => {
    const entry1 = makeEntry(1, GENESIS_HASH);
    expect(verifyFiscalHash(entry1, secret)).toBe(true);
    expect(verifyFiscalHash(entry1, 'wrong-secret')).toBe(false);
  });

  it('detects tampering in fiscal hash', () => {
    const entry1 = makeEntry(1, GENESIS_HASH);
    const tampered = { ...entry1, commandPayload: 'tampered payload' };
    expect(verifyFiscalHash(tampered, secret)).toBe(false);
  });

  it('verifies valid fiscal chain', () => {
    const e1 = makeEntry(1, GENESIS_HASH);
    const e2 = makeEntry(2, e1.hash);
    const e3 = makeEntry(3, e2.hash);

    const result = verifyFiscalChain([e1, e2, e3], secret);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeNull();
  });

  it('detects invalid genesis hash in chain', () => {
    const e1 = makeEntry(1, 'invalid_genesis');
    const result = verifyFiscalChain([e1], secret);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it('detects broken link in chain', () => {
    const e1 = makeEntry(1, GENESIS_HASH);
    const e2 = makeEntry(2, 'wrong_prev_hash');
    const result = verifyFiscalChain([e1, e2], secret);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});
