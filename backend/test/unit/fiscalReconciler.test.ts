import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/acubeClient', () => ({
  createAcubeReceipt: vi.fn(),
}));

import { createAcubeReceipt } from '../../src/utils/acubeClient';
import {
  ensureSessionInvoiced,
  startFiscalReconciler,
  type FiscalReconcilerDeps,
} from '../../src/utils/fiscalReconciler';

const mockCreateAcubeReceipt = vi.mocked(createAcubeReceipt);

function makePrisma(session: any, stale: any[] = []) {
  return {
    checkoutSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue(stale),
    },
  } as any;
}

const paidSession = {
  id: 'sess-1',
  status: 'paid',
  fiscalStatus: 'pending',
  totalAmount: 1000,
  venue: { acubeApiKey: 'acube_key_test_123', acubeOrganizationId: 'org_1' },
  tickets: [{ productName: 'Vodka Redbull', price: 1000, vatRate: 10 }],
};

const silentLogger = { info: vi.fn(), error: vi.fn() };

describe('ensureSessionInvoiced', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skippa se la sessione non esiste', async () => {
    const prisma = makePrisma(null);
    const deps: FiscalReconcilerDeps = { prisma, logger: silentLogger };
    expect(await ensureSessionInvoiced(deps, 'missing')).toBe('skipped');
    expect(mockCreateAcubeReceipt).not.toHaveBeenCalled();
  });

  it('skippa se la sessione non è paid', async () => {
    const prisma = makePrisma({ ...paidSession, status: 'pending' });
    expect(await ensureSessionInvoiced({ prisma, logger: silentLogger }, 'sess-1')).toBe('skipped');
    expect(mockCreateAcubeReceipt).not.toHaveBeenCalled();
  });

  it('skippa se già invoiced (idempotenza)', async () => {
    const prisma = makePrisma({ ...paidSession, fiscalStatus: 'invoiced' });
    expect(await ensureSessionInvoiced({ prisma, logger: silentLogger }, 'sess-1')).toBe('skipped');
    expect(mockCreateAcubeReceipt).not.toHaveBeenCalled();
  });

  it('fattura una sessione paid non invoiced e aggiorna il DB', async () => {
    const prisma = makePrisma(paidSession);
    mockCreateAcubeReceipt.mockResolvedValue({ id: 'rec_1', pdfUrl: '/api/receipt/pdf/sess-1' });

    const outcome = await ensureSessionInvoiced({ prisma, logger: silentLogger }, 'sess-1');

    expect(outcome).toBe('invoiced');
    expect(mockCreateAcubeReceipt).toHaveBeenCalledWith(
      paidSession.venue,
      expect.objectContaining({ id: 'sess-1' }),
      paidSession.tickets,
      { isProduction: false }
    );
    expect(prisma.checkoutSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: {
        fiscalReceiptUrl: '/api/receipt/pdf/sess-1',
        fiscalDocNumber: 'rec_1',
        fiscalStatus: 'invoiced',
      },
    });
  });

  it('su errore A-Cube marca invoicing_failed SENZA lanciare', async () => {
    const prisma = makePrisma(paidSession);
    mockCreateAcubeReceipt.mockRejectedValue(new Error('A-Cube down'));

    const outcome = await ensureSessionInvoiced({ prisma, logger: silentLogger }, 'sess-1');

    expect(outcome).toBe('failed');
    expect(prisma.checkoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', fiscalStatus: { not: 'invoiced' } },
      data: { fiscalStatus: 'invoicing_failed' },
    });
  });

  it('passa isProduction alle credenziali A-Cube', async () => {
    const prisma = makePrisma(paidSession);
    mockCreateAcubeReceipt.mockResolvedValue({ id: 'rec_1', pdfUrl: '/x' });

    await ensureSessionInvoiced({ prisma, isProduction: true, logger: silentLogger }, 'sess-1');

    expect(mockCreateAcubeReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { isProduction: true }
    );
  });
});

describe('startFiscalReconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('il tick ritenta le sessioni pagate non fatturate', async () => {
    const prisma = makePrisma(paidSession, [{ id: 'sess-1' }]);
    mockCreateAcubeReceipt.mockResolvedValue({ id: 'rec_1', pdfUrl: '/x' });

    const handle = startFiscalReconciler({ prisma, logger: silentLogger }, { intervalMs: 60_000 });
    await handle.tick();
    handle.stop();

    expect(prisma.checkoutSession.findMany).toHaveBeenCalledWith({
      where: { status: 'paid', fiscalStatus: { in: ['pending', 'invoicing_failed'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    expect(mockCreateAcubeReceipt).toHaveBeenCalledTimes(1);
  });

  it('il tick non lancia su errore DB e non si sovrappone', async () => {
    const prisma = makePrisma(null);
    prisma.checkoutSession.findMany.mockRejectedValue(new Error('DB down'));

    const handle = startFiscalReconciler({ prisma, logger: silentLogger }, { intervalMs: 60_000 });
    await expect(handle.tick()).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
    handle.stop();
  });
});
