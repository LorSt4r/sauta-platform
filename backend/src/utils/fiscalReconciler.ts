import { PrismaClient } from '@prisma/client';
import { createAcubeReceipt } from './acubeClient';

/**
 * [FIX A] Riconciliazione fiscale A-Cube.
 *
 * Problema: la chiamata A-Cube avveniva DOPO il commit idempotente della
 * sessione (status='paid'). Un crash o un errore A-Cube in quella finestra
 * lasciava la vendita pagata ma MAI fatturata: i retry Stripe facevano
 * short-circuit sul guard idempotente e non esisteva alcuna riconciliazione.
 *
 * Soluzione:
 * - `ensureSessionInvoiced()` — fatturazione idempotente e non-throwing:
 *   self-skip se già 'invoiced' o non 'paid'; su errore A-Cube marca
 *   fiscalStatus='invoicing_failed' invece di propagare (il chiamante può
 *   rispondere 200 a Stripe senza retry a vuoto).
 * - `startFiscalReconciler()` — job periodico che ritenta le sessioni
 *   pagate ma non fatturate ('pending' | 'invoicing_failed').
 */

export interface FiscalReconcilerLogger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface FiscalReconcilerDeps {
  prisma: PrismaClient;
  isProduction?: boolean;
  logger?: FiscalReconcilerLogger;
}

export type InvoicingOutcome = 'invoiced' | 'skipped' | 'failed';

/**
 * Garantisce la fatturazione di una sessione. Idempotente.
 * Non lancia mai per errori A-Cube (marca invoicing_failed); può lanciare
 * solo per errori DB (il chiamante decide se rispondere 5xx).
 */
export async function ensureSessionInvoiced(
  deps: FiscalReconcilerDeps,
  sessionId: string
): Promise<InvoicingOutcome> {
  const { prisma } = deps;
  const log = deps.logger ?? console;

  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: { venue: true, tickets: true },
  });

  if (!session || session.status !== 'paid' || session.fiscalStatus === 'invoiced') {
    return 'skipped';
  }

  try {
    const acubeRes = await createAcubeReceipt(session.venue, session, session.tickets, {
      isProduction: deps.isProduction ?? false,
    });
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        fiscalReceiptUrl: acubeRes.pdfUrl,
        fiscalDocNumber: acubeRes.id,
        fiscalStatus: 'invoiced',
      },
    });
    log.info(`[FiscalReconciler] Sessione ${sessionId} fatturata: ${acubeRes.id}`);
    return 'invoiced';
  } catch (err) {
    log.error(
      `[FiscalReconciler] Fatturazione fallita per ${sessionId}:`,
      (err as Error).message
    );
    // Marca come fallita SOLO se nel frattempo non è stata fatturata altrove
    await prisma.checkoutSession.updateMany({
      where: { id: sessionId, fiscalStatus: { not: 'invoiced' } },
      data: { fiscalStatus: 'invoicing_failed' },
    });
    return 'failed';
  }
}

export interface FiscalReconcilerHandle {
  stop: () => void;
  /** Esegue un giro di riconciliazione (esposto per i test). */
  tick: () => Promise<void>;
}

/**
 * Avvia il job periodico di riconciliazione. Il timer è unref'd: non tiene
 * vivo il processo. Un solo tick alla volta (guard anti-sovrapposizione).
 */
export function startFiscalReconciler(
  deps: FiscalReconcilerDeps,
  opts: { intervalMs?: number; batchSize?: number } = {}
): FiscalReconcilerHandle {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const batchSize = opts.batchSize ?? 20;
  const log = deps.logger ?? console;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stale = await deps.prisma.checkoutSession.findMany({
        where: {
          status: 'paid',
          fiscalStatus: { in: ['pending', 'invoicing_failed'] },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });
      for (const s of stale) {
        await ensureSessionInvoiced(deps, s.id);
      }
    } catch (err) {
      log.error('[FiscalReconciler] Errore nel tick:', (err as Error).message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
