import { PrismaClient, Prisma } from '@prisma/client';
import { computeFiscalHash, GENESIS_HASH } from './fiscalIntegrity';

/**
 * [FIX 1.5/2.8] Helper condiviso per hash chain FiscalLog.
 * Estratto da ws/server.ts per riuso in stripe.ts (void endpoint).
 */

export async function getLastFiscalEntry(
  prisma: PrismaClient | Prisma.TransactionClient,
  venueId: string
): Promise<{ sequenceNumber: number; hash: string }> {
  const last = await prisma.fiscalLog.findFirst({
    where: { venueId },
    orderBy: { sequenceNumber: 'desc' },
  });
  if (!last) {
    return { sequenceNumber: 0, hash: GENESIS_HASH };
  }
  return { sequenceNumber: last.sequenceNumber + 1, hash: last.hash };
}

/**
 * [FIX Concurrency] Esegue una transazione con retry ottimistico per collisioni
 * di sequenza su FiscalLog (Prisma P2002 su venueId + sequenceNumber).
 */
export async function withFiscalRetry<T>(
  prisma: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
  maxRetries = 12
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      return await prisma.$transaction(async (tx) => {
        return await action(tx);
      });
    } catch (err: unknown) {
      const isP2002 = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      const targetStr = isP2002 ? JSON.stringify(err.meta?.target ?? '') : '';
      const isFiscalSequenceCollision =
        isP2002 &&
        (targetStr.includes('sequence_number') ||
          targetStr.includes('venue_id') ||
          targetStr.includes('fiscal_logs'));

      if (isFiscalSequenceCollision && attempt < maxRetries) {
        const backoffMs =
          Math.min(2 ** (attempt - 1) * 10, 250) +
          Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Transaction failed after ${maxRetries} retries due to FiscalLog sequence collision.`);
}

export { computeFiscalHash, GENESIS_HASH };
