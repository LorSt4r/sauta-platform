import { describe, it, expect } from 'vitest';
import {
  computeVatBreakdown,
  computeMultiVatBreakdown,
  canTransitionFiscal,
  validateFiscalTransition,
  validateVoidRequest,
  isSameDayVoid,
  determineVoidType,
  voidTypeToOperationKind,
  type FiscalStatus,
  type VoidReason,
} from '../../src/utils/fiscal';

describe('computeVatBreakdown [FIX 2.4]', () => {
  it('calcola IVA 10% su totale 1000 (€10.00)', () => {
    const r = computeVatBreakdown(1000, 10);
    expect(r.grossAmount).toBe(1000);
    expect(r.vatRate).toBe(10);
    expect(r.netAmount).toBe(909); // 1000 / 1.1 = 909.09 → round 909
    expect(r.vatAmount).toBe(91); // 1000 - 909
  });

  it('calcola IVA 22% su totale 1220', () => {
    const r = computeVatBreakdown(1220, 22);
    expect(r.grossAmount).toBe(1220);
    expect(r.netAmount).toBe(1000); // 1220 / 1.22 = 1000
    expect(r.vatAmount).toBe(220);
  });

  it('IVA 0% → netAmount = grossAmount', () => {
    const r = computeVatBreakdown(500, 0);
    expect(r.netAmount).toBe(500);
    expect(r.vatAmount).toBe(0);
  });

  it('somma net + vat = gross', () => {
    for (const [gross, rate] of [[1000, 10], [5000, 22], [333, 10], [100, 5]]) {
      const r = computeVatBreakdown(gross, rate);
      expect(r.netAmount + r.vatAmount).toBe(gross);
    }
  });
});

describe('computeMultiVatBreakdown [FIX 2.4]', () => {
  it('aggrega item per aliquota uguale', () => {
    const items = [
      { grossAmount: 500, vatRate: 10 },
      { grossAmount: 300, vatRate: 10 },
      { grossAmount: 200, vatRate: 22 },
    ];
    const result = computeMultiVatBreakdown(items);
    expect(result.length).toBe(2);
    // 10%: 500+300=800
    expect(result[0].vatRate).toBe(10);
    expect(result[0].grossAmount).toBe(800);
    // 22%: 200
    expect(result[1].vatRate).toBe(22);
    expect(result[1].grossAmount).toBe(200);
  });

  it('ritorna array vuoto per items vuoti', () => {
    expect(computeMultiVatBreakdown([])).toEqual([]);
  });

  it('ordina per aliquota crescente', () => {
    const items = [
      { grossAmount: 100, vatRate: 22 },
      { grossAmount: 100, vatRate: 10 },
      { grossAmount: 100, vatRate: 5 },
    ];
    const result = computeMultiVatBreakdown(items);
    expect(result.map(r => r.vatRate)).toEqual([5, 10, 22]);
  });
});

describe('canTransitionFiscal / validateFiscalTransition [FIX 2.1]', () => {
  it('permette pending → invoiced', () => {
    expect(canTransitionFiscal('pending', 'invoiced')).toBe(true);
  });

  it('permette invoiced → voided (same day)', () => {
    expect(canTransitionFiscal('invoiced', 'voided')).toBe(true);
  });

  it('permette invoiced → storno (giorno successivo)', () => {
    expect(canTransitionFiscal('invoiced', 'storno')).toBe(true);
  });

  it('permette voided → storno', () => {
    expect(canTransitionFiscal('voided', 'storno')).toBe(true);
  });

  it('rifiuta pending → voided (deve passare per invoiced)', () => {
    expect(canTransitionFiscal('pending', 'voided')).toBe(false);
  });

  it('rifiuta storno → qualsiasi (stato terminale)', () => {
    expect(canTransitionFiscal('storno', 'pending')).toBe(false);
    expect(canTransitionFiscal('storno', 'invoiced')).toBe(false);
    expect(canTransitionFiscal('storno', 'voided')).toBe(false);
  });

  it('validateFiscalTransition throw su transizione non permessa', () => {
    expect(() => validateFiscalTransition('pending', 'voided')).toThrow();
    expect(() => validateFiscalTransition('storno', 'invoiced')).toThrow();
  });

  it('validateFiscalTransition non throw su transizione permessa', () => {
    expect(() => validateFiscalTransition('pending', 'invoiced')).not.toThrow();
    expect(() => validateFiscalTransition('invoiced', 'voided')).not.toThrow();
  });
});

describe('validateVoidRequest [FIX 2.3]', () => {
  it('accetta richiesta valida', () => {
    const result = validateVoidRequest({
      sessionId: 's1',
      reason: 'errore_cassa',
      voidedById: 'user1',
    });
    expect(result.valid).toBe(true);
  });

  it('rifiuta senza sessionId', () => {
    const result = validateVoidRequest({ reason: 'errore_cassa', voidedById: 'u1' });
    expect(result.valid).toBe(false);
  });

  it('rifiuta senza reason', () => {
    const result = validateVoidRequest({ sessionId: 's1', voidedById: 'u1' });
    expect(result.valid).toBe(false);
  });

  it('rifiuta senza voidedById', () => {
    const result = validateVoidRequest({ sessionId: 's1', reason: 'errore_cassa' });
    expect(result.valid).toBe(false);
  });

  it('rifiuta reason non valido', () => {
    const result = validateVoidRequest({ sessionId: 's1', reason: 'motivo_inventato' as any, voidedById: 'u1' });
    expect(result.valid).toBe(false);
  });
});

describe('isSameDayVoid / determineVoidType [FIX 2.3]', () => {
  it('isSameDayVoid true per stesso giorno', () => {
    const orig = new Date(2026, 6, 14, 15, 0, 0); // Jul 14 2026 15:00 local
    const now = new Date(2026, 6, 14, 23, 0, 0); // Jul 14 2026 23:00 local
    expect(isSameDayVoid(orig, now)).toBe(true);
  });

  it('isSameDayVoid false per giorno successivo', () => {
    const orig = new Date(2026, 6, 14, 15, 0, 0);
    const now = new Date(2026, 6, 15, 10, 0, 0);
    expect(isSameDayVoid(orig, now)).toBe(false);
  });

  it('isSameDayVoid calcola correttamente i confini di mezzanotte in orario Europe/Rome', () => {
    // 2026-07-14T20:00:00Z = 22:00 CEST Jul 14 in Europe/Rome
    // 2026-07-14T23:30:00Z = 01:30 CEST Jul 15 in Europe/Rome (mezzanotte superata in Italia)
    const orig = new Date('2026-07-14T20:00:00Z');
    const voidAfterMidnightRome = new Date('2026-07-14T23:30:00Z');
    expect(isSameDayVoid(orig, voidAfterMidnightRome)).toBe(false);

    // 2026-07-13T22:30:00Z = 00:30 CEST Jul 14 in Europe/Rome
    // 2026-07-14T01:00:00Z = 03:00 CEST Jul 14 in Europe/Rome (stesso giorno solare in Italia)
    const origEarlyMorningRome = new Date('2026-07-13T22:30:00Z');
    const voidSameMorningRome = new Date('2026-07-14T01:00:00Z');
    expect(isSameDayVoid(origEarlyMorningRome, voidSameMorningRome)).toBe(true);
  });

  it('determineVoidType → voided per same day', () => {
    const orig = new Date(2026, 6, 14, 15, 0, 0);
    const now = new Date(2026, 6, 14, 23, 59, 0);
    expect(determineVoidType(orig, now)).toBe('voided');
  });

  it('determineVoidType → storno per giorno successivo', () => {
    const orig = new Date(2026, 6, 14, 15, 0, 0);
    const now = new Date(2026, 6, 15, 0, 1, 0);
    expect(determineVoidType(orig, now)).toBe('storno');
  });
});

describe('voidTypeToOperationKind [FIX 2.8]', () => {
  it('voided → annullamento', () => {
    expect(voidTypeToOperationKind('voided')).toBe('annullamento');
  });

  it('storno → storno', () => {
    expect(voidTypeToOperationKind('storno')).toBe('storno');
  });
});
