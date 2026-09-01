import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Hash iniziale per la catena del FiscalLog.
 */
export const GENESIS_HASH = createHash('sha256').update('SAUTA_GENESIS').digest('hex');

export interface ChainEntry {
  sequenceNumber: number;
  previousHash: string;
  hash: string;
}

export interface FiscalHashParams {
  sequenceNumber: number;
  previousHash: string;
  sessionId: string;
  timestamp: string;
  printerBrand: string;
  commandPayload: string;
  statusResponse: string;
  success: boolean;
  errorMessage: string | null;
}

/**
 * Calcola l'hash HMAC-SHA256 deterministico di una riga di FiscalLog.
 */
export function computeFiscalHash(entry: FiscalHashParams, secret: string): string {
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
 * Verifica l'hash di un singolo record FiscalLog.
 */
export function verifyFiscalHash(
  entry: FiscalHashParams & { hash: string },
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
 * Verifica che una sequenza di FiscalLog formi una catena valida.
 */
export function verifyFiscalChain(
  entries: Array<FiscalHashParams & { hash: string }>,
  secret: string
): { valid: boolean; brokenAt: number | null; reason: string | null } {
  const firstEntry = entries[0];
  if (!firstEntry) {
    return { valid: true, brokenAt: null, reason: null };
  }

  if (firstEntry.previousHash !== GENESIS_HASH) {
    return {
      valid: false,
      brokenAt: 0,
      reason: `First entry previousHash != GENESIS (got ${firstEntry.previousHash})`,
    };
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
        return {
          valid: false,
          brokenAt: i,
          reason: `Chain broken at entry ${entry.sequenceNumber}: previousHash != prev.hash`,
        };
      }
    }
  }

  return { valid: true, brokenAt: null, reason: null };
}
