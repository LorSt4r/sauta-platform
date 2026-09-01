import { describe, it, expect } from 'vitest';
import {
  signMessage,
  verifyMessage,
  randomNonce,
  computeFiscalHash,
  verifyFiscalHash,
  verifyFiscalChain,
  GENESIS_HASH,
} from '../src/security';

const TEST_SECRET = 'test-secret-key-for-unit-tests';

// --- HMAC nonce tests (1.4) ---

describe('signMessage / verifyMessage [FIX 1.4]', () => {
  it('firma e verifica un messaggio valido', () => {
    const data = { event: 'PRINT_RECEIPT', sessionId: 's1', tickets: [] };
    const signed = signMessage(data, TEST_SECRET);
    const result = verifyMessage(signed, TEST_SECRET);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toEqual(data);
  });

  it('rifiuta messaggio con firma invalida (secret diverso)', () => {
    const signed = signMessage({ event: 'PRINT_RECEIPT' }, TEST_SECRET);
    const result = verifyMessage(signed, 'wrong-secret');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe('Invalid signature');
  });

  it('rifiuta messaggio con payload manomesso', () => {
    const signed = signMessage({ event: 'PRINT_RECEIPT', amount: 1000 }, TEST_SECRET);
    signed.payload = { event: 'PRINT_RECEIPT', amount: 999999 }; // tampered
    const result = verifyMessage(signed, TEST_SECRET);
    expect(result.valid).toBe(false);
  });

  it('rifiuta messaggio scaduto (timestamp troppo vecchio)', () => {
    const oldTs = Date.now() - 10 * 60 * 1000; // 10 min fa
    const signed = signMessage({ event: 'X' }, TEST_SECRET, randomNonce(), oldTs);
    const result = verifyMessage(signed, TEST_SECRET, 5 * 60 * 1000);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/expired/i);
  });

  it('rifiuta messaggio con timestamp futuro (clock skew)', () => {
    const futureTs = Date.now() + 10 * 60 * 1000;
    const signed = signMessage({ event: 'X' }, TEST_SECRET, randomNonce(), futureTs);
    const result = verifyMessage(signed, TEST_SECRET, 5 * 60 * 1000);
    expect(result.valid).toBe(false);
  });

  it('genera nonce diversi ad ogni chiamata', () => {
    const n1 = randomNonce();
    const n2 = randomNonce();
    expect(n1).not.toBe(n2);
    expect(n1.length).toBe(32);
  });

  it('accetta maxAge custom', () => {
    const ts = Date.now() - 3 * 60 * 1000; // 3 min fa
    const signed = signMessage({ event: 'X' }, TEST_SECRET, randomNonce(), ts);
    // Default 5min → valido
    expect(verifyMessage(signed, TEST_SECRET).valid).toBe(true);
    // maxAge 1min → scaduto
    expect(verifyMessage(signed, TEST_SECRET, 1 * 60 * 1000).valid).toBe(false);
  });

  it('rifiuta se manca signature/nonce/timestamp', () => {
    const result = verifyMessage({ payload: {}, nonce: '', timestamp: 0, signature: '' }, TEST_SECRET);
    expect(result.valid).toBe(false);
  });
});

// --- Hash chain tests (1.5) ---

describe('computeFiscalHash / verifyFiscalHash [FIX 1.5]', () => {
  const makeEntry = (seq: number, prevHash: string, overrides: Partial<any> = {}) => ({
    sequenceNumber: seq,
    previousHash: prevHash,
    sessionId: 's1',
    timestamp: new Date().toISOString(),
    printerBrand: 'epson',
    commandPayload: '<xml>test</xml>',
    statusResponse: 'ok',
    success: true,
    errorMessage: null,
    ...overrides,
  });

  it('calcola hash deterministico per stesso input', () => {
    const entry = makeEntry(0, GENESIS_HASH);
    const h1 = computeFiscalHash(entry, TEST_SECRET);
    const h2 = computeFiscalHash(entry, TEST_SECRET);
    expect(h1).toBe(h2);
  });

  it('hash diverso per secret diverso', () => {
    const entry = makeEntry(0, GENESIS_HASH);
    const h1 = computeFiscalHash(entry, TEST_SECRET);
    const h2 = computeFiscalHash(entry, 'other-secret');
    expect(h1).not.toBe(h2);
  });

  it('hash diverso per payload diverso (tamper detection)', () => {
    const e1 = makeEntry(0, GENESIS_HASH, { success: true });
    const e2 = makeEntry(0, GENESIS_HASH, { success: false });
    expect(computeFiscalHash(e1, TEST_SECRET)).not.toBe(computeFiscalHash(e2, TEST_SECRET));
  });

  it('verifica hash corretto', () => {
    const entry = makeEntry(0, GENESIS_HASH);
    const hash = computeFiscalHash(entry, TEST_SECRET);
    expect(verifyFiscalHash({ ...entry, hash }, TEST_SECRET)).toBe(true);
  });

  it('rifiuta hash manomesso', () => {
    const entry = makeEntry(0, GENESIS_HASH);
    const hash = computeFiscalHash(entry, TEST_SECRET);
    const tampered = hash.slice(0, -2) + 'ff';
    expect(verifyFiscalHash({ ...entry, hash: tampered }, TEST_SECRET)).toBe(false);
  });

  it('GENESIS_HASH è deterministico e non vuoto', () => {
    expect(GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyFiscalChain [FIX 1.5]', () => {
  const makeChainEntry = (seq: number, prevHash: string, secret: string, overrides: Partial<any> = {}) => {
    const base = {
      sequenceNumber: seq,
      previousHash: prevHash,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      printerBrand: 'epson',
      commandPayload: `<xml>${seq}</xml>`,
      statusResponse: 'ok',
      success: true,
      errorMessage: null,
      ...overrides,
    };
    const hash = computeFiscalHash(base, secret);
    return { ...base, hash };
  };

  it('catena valida di 3 entry', () => {
    const e0 = makeChainEntry(0, GENESIS_HASH, TEST_SECRET);
    const e1 = makeChainEntry(1, e0.hash, TEST_SECRET);
    const e2 = makeChainEntry(2, e1.hash, TEST_SECRET);
    const result = verifyFiscalChain([e0, e1, e2], TEST_SECRET);
    expect(result.valid).toBe(true);
  });

  it('rifiuta catena con prima entry previousHash != GENESIS', () => {
    const e0 = makeChainEntry(0, 'wrong-genesis', TEST_SECRET);
    const result = verifyFiscalChain([e0], TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it('rifiuta catena con hash manomesso in mezzo', () => {
    const e0 = makeChainEntry(0, GENESIS_HASH, TEST_SECRET);
    const e1 = makeChainEntry(1, e0.hash, TEST_SECRET);
    // Manometti e1: cambia success ma mantiene hash vecchio
    const tampered = { ...e1, success: false };
    const e2 = makeChainEntry(2, e1.hash, TEST_SECRET);
    const result = verifyFiscalChain([e0, tampered, e2], TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('rifiuta catena con link rotto (previousHash != prev.hash)', () => {
    const e0 = makeChainEntry(0, GENESIS_HASH, TEST_SECRET);
    const e1 = makeChainEntry(1, 'aaaaaaaa', TEST_SECRET); // wrong previousHash
    const result = verifyFiscalChain([e0, e1], TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('catena vuota è valida', () => {
    expect(verifyFiscalChain([], TEST_SECRET).valid).toBe(true);
  });
});
