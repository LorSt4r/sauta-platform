/**
 * [FIX 2.1 - 2.8] Logica fiscale core — funzioni pure testabili.
 *
 * - 2.1: fiscalStatus separato da status (payment vs fiscale)
 * - 2.3: Annulli/storni (void/storno)
 * - 2.4: IVA per-prodotto + calcolo imponibile
 * - 2.5: priceSnapshot (immutable al momento acquisto)
 * - 2.8: operationKind/correlativeId per FiscalLog
 */

// --- 2.4: IVA + calcoli fiscali ---

export interface VatBreakdown {
  vatRate: number;
  netAmount: number; // imponibile
  vatAmount: number; // IVA
  grossAmount: number; // totale
}

/**
 * Calcola il breakdown IVA dato un totale lordo e un'aliquota.
 * Formula: imponibile = totale / (1 + vatRate/100)
 *          IVA = totale - imponibile
 */
export function computeVatBreakdown(grossAmount: number, vatRate: number): VatBreakdown {
  const divisor = 1 + vatRate / 100;
  const netAmount = Math.round(grossAmount / divisor);
  const vatAmount = grossAmount - netAmount;
  return { vatRate, netAmount, vatAmount, grossAmount };
}

/**
 * Calcola il breakdown IVA aggregato per multiple aliquote.
 * Ritorna un array di breakdown, uno per aliquota.
 */
export function computeMultiVatBreakdown(
  items: Array<{ grossAmount: number; vatRate: number }>
): VatBreakdown[] {
  const byRate = new Map<number, number>();
  for (const item of items) {
    const current = byRate.get(item.vatRate) ?? 0;
    byRate.set(item.vatRate, current + item.grossAmount);
  }
  return Array.from(byRate.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rate, gross]) => computeVatBreakdown(gross, rate));
}

// --- 2.1: Fiscal status transitions ---

export type FiscalStatus = 'pending' | 'invoiced' | 'voided' | 'storno';
export type PaymentStatus = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'failed';

/**
 * Macchina a stati per fiscalStatus.
 * Transizioni permesse:
 *   pending → invoiced (RT stampa scontrino)
 *   invoiced → voided (annullamento entro la stessa giornata)
 *   invoiced → storno (storno giorno successivo)
 *   voided → storno (non si può annullare due volte)
 *   storno → (nessuna, stato terminale)
 */
const ALLOWED_FISCAL_TRANSITIONS: Record<FiscalStatus, FiscalStatus[]> = {
  pending: ['invoiced'],
  invoiced: ['voided', 'storno'],
  voided: ['storno'],
  storno: [],
};

export function canTransitionFiscal(from: FiscalStatus, to: FiscalStatus): boolean {
  return ALLOWED_FISCAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Valida una transizione fiscale. Throw se non permessa.
 */
export function validateFiscalTransition(from: FiscalStatus, to: FiscalStatus): void {
  if (!canTransitionFiscal(from, to)) {
    throw new Error(
      `Transizione fiscale non permessa: ${from} → ${to}. Permesse: ${ALLOWED_FISCAL_TRANSITIONS[from]?.join(', ') || 'nessuna'}`
    );
  }
}

// --- 2.3: Annulli/storni ---

export type VoidReason = 'errore_cassa' | 'errore_operatore' | 'mancata_erogazione' | 'cliente_assente' | 'altro';

export interface VoidRequest {
  sessionId: string;
  reason: VoidReason;
  voidedById: string;
}

/**
 * Valida una richiesta di annullamento.
 * - Deve avere sessionId, reason, voidedById
 * - reason deve essere uno dei motivi validi
 */
export function validateVoidRequest(req: Partial<VoidRequest>): { valid: true; data: VoidRequest } | { valid: false; error: string } {
  if (!req.sessionId) return { valid: false, error: 'sessionId mancante' };
  if (!req.reason) return { valid: false, error: 'reason mancante' };
  if (!req.voidedById) return { valid: false, error: 'voidedById mancante' };

  const validReasons: VoidReason[] = ['errore_cassa', 'errore_operatore', 'mancata_erogazione', 'cliente_assente', 'altro'];
  if (!validReasons.includes(req.reason)) {
    return { valid: false, error: `reason non valido: ${req.reason}` };
  }

  return { valid: true, data: { sessionId: req.sessionId, reason: req.reason, voidedById: req.voidedById } };
}

function getRomeDateString(date: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

/**
 * Determina se un annullamento è "same day" (entro la mezzanotte dello stesso giorno in orario italiano Europe/Rome).
 * Gli annullamenti same-day → voided. Oltre la mezzanotte → storno.
 */
export function isSameDayVoid(originalDate: Date, voidDate: Date = new Date()): boolean {
  return getRomeDateString(new Date(originalDate)) === getRomeDateString(new Date(voidDate));
}

/**
 * Determina il tipo di operazione fiscale per un annullamento.
 * Same-day → annullamento (voided). Giorno successivo → storno.
 */
export function determineVoidType(originalDate: Date, voidDate: Date = new Date()): 'voided' | 'storno' {
  return isSameDayVoid(originalDate, voidDate) ? 'voided' : 'storno';
}

// --- 2.8: operationKind ---

export type OperationKind = 'stampa' | 'annullamento' | 'storno' | 'chiusura';

/**
 * Mappa un tipo di annullamento all'operationKind FiscalLog.
 */
export function voidTypeToOperationKind(voidType: 'voided' | 'storno'): OperationKind {
  return voidType === 'voided' ? 'annullamento' : 'storno';
}
