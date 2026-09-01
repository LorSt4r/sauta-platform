import { createHmac, createHash, timingSafeEqual } from 'crypto';

/**
 * Modulo crypto puro per sicurezza LAN/Relay.
 * [FIX 1.4] HMAC nonce per PRINT_RECEIPT/STATUS (anti-replay).
 * [FIX 1.5] Hash chain per FiscalLog (tamper-evident).
 *
 * Tutte le funzioni sono pure e testabili senza side-effect.
 */

// --- HMAC nonce per messaggi WS (1.4) ---

export interface SignedMessage {
  payload: unknown;
  nonce: string;
  timestamp: number;
  signature: string;
}

/**
 * Firma un messaggio con HMAC-SHA256 usando secret + nonce + timestamp.
 * Il nonce previene replay attack; il timestamp previene vecchi messaggi riutilizzati.
 */
export function signMessage(
  data: unknown,
  secret: string,
  nonce: string = randomNonce(),
  timestamp: number = Date.now()
): SignedMessage {
  const payloadString = JSON.stringify(data);
  const message = `${payloadString}:${nonce}:${timestamp}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { payload: data, nonce, timestamp, signature };
}

/**
 * Verifica un messaggio firmato con HMAC-SHA256.
 * - Verifica firma (timing-safe comparison)
 * - Verifica timestamp entro maxAgeMs (default 5 min)
 * - Ritorna { valid, data } o { valid: false, error }
 */
export function verifyMessage(
  msg: SignedMessage,
  secret: string,
  maxAgeMs: number = 5 * 60 * 1000
): { valid: true; data: unknown } | { valid: false; error: string } {
  if (!msg.signature || !msg.nonce || !msg.timestamp) {
    return { valid: false, error: 'Missing signature/nonce/timestamp' };
  }

  const now = Date.now();
  const age = now - msg.timestamp;
  if (Math.abs(age) > maxAgeMs) {
    return { valid: false, error: `Message expired (age ${age}ms > ${maxAgeMs}ms)` };
  }

  const payloadString = JSON.stringify(msg.payload);
  const message = `${payloadString}:${msg.nonce}:${msg.timestamp}`;
  const expectedSig = createHmac('sha256', secret).update(message).digest('hex');

  if (!timingSafeEqual(Buffer.from(msg.signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true, data: msg.payload };
}

/**
 * Genera un nonce casuale di 32 byte in hex.
 */
export function randomNonce(): string {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32);
}

// --- Hash chain per FiscalLog (1.5) ---

export const GENESIS_HASH = createHash('sha256').update('SAUTA_GENESIS').digest('hex');

export interface ChainEntry {
  sequenceNumber: number;
  previousHash: string;
  hash: string;
}

/**
 * Calcola l'hash di un FiscalLog entry per la hash chain.
 * L'hash copre: sequenceNumber + previousHash + sessionId + timestamp + payload + statusResponse + success
 */
export function computeFiscalHash(
  entry: {
    sequenceNumber: number;
    previousHash: string;
    sessionId: string;
    timestamp: string;
    printerBrand: string;
    commandPayload: string;
    statusResponse: string;
    success: boolean;
    errorMessage: string | null;
  },
  secret: string
): string {
  const content = JSON.stringify({
    seq: entry.sequenceNumber,
    prev: entry.previousHash,
    sid: entry.sessionId,
    ts: entry.timestamp,
    brand: entry.printerBrand,
    cmd: entry.commandPayload,
    resp: entry.statusResponse,
    ok: entry.success,
    err: entry.errorMessage,
  });
  return createHmac('sha256', secret).update(content).digest('hex');
}

/**
 * Verifica una hash chain: dato un entry e il suo previousHash, verifica che l'hash sia corretto.
 */
export function verifyFiscalHash(
  entry: {
    sequenceNumber: number;
    previousHash: string;
    hash: string;
    sessionId: string;
    timestamp: string;
    printerBrand: string;
    commandPayload: string;
    statusResponse: string;
    success: boolean;
    errorMessage: string | null;
  },
  secret: string
): boolean {
  const { hash, ...rest } = entry;
  const computed = computeFiscalHash(rest, secret);
  try {
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verifica che una catena di entry sia valida (ogni previousHash == hash dell'entry precedente).
 */
export function verifyFiscalChain(
  entries: Array<{
    sequenceNumber: number;
    previousHash: string;
    hash: string;
    sessionId: string;
    timestamp: string;
    printerBrand: string;
    commandPayload: string;
    statusResponse: string;
    success: boolean;
    errorMessage: string | null;
  }>,
  secret: string
): { valid: boolean; brokenAt: number | null; reason: string | null } {
  const firstEntry = entries[0];
  if (!firstEntry) {
    return { valid: true, brokenAt: null, reason: null };
  }

  // Prima entry: previousHash deve essere GENESIS
  if (firstEntry.previousHash !== GENESIS_HASH) {
    return { valid: false, brokenAt: 0, reason: `First entry previousHash != GENESIS (got ${firstEntry.previousHash})` };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (!verifyFiscalHash(entry, secret)) {
      return { valid: false, brokenAt: i, reason: `Hash mismatch at entry ${entry.sequenceNumber}` };
    }
    if (i > 0) {
      const prevEntry = entries[i - 1];
      if (!prevEntry || entry.previousHash !== prevEntry.hash) {
        return { valid: false, brokenAt: i, reason: `Chain broken at entry ${entry.sequenceNumber}: previousHash != prev.hash` };
      }
    }
  }


  return { valid: true, brokenAt: null, reason: null };
}
