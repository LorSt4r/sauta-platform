import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { withFiscalRetry, computeFiscalHash, GENESIS_HASH } from '../../src/utils/fiscalLogHelper';

describe('Challenger 2: FiscalLog Concurrency & P2002 Retry Loop Empirical Verification', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
    app = await createTestApp(prisma);
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.fiscalLog.deleteMany();
    await prisma.ticket.deleteMany();
    await prisma.checkoutSession.deleteMany();
    await prisma.product.deleteMany();
    await prisma.venue.deleteMany();
  });

  describe('Synthetic Unit Tests for withFiscalRetry', () => {
    it('retries on P2002 sequence number collision and resolves when action succeeds', async () => {
      let attempts = 0;
      const mockAction = async (tx: Prisma.TransactionClient) => {
        attempts++;
        if (attempts < 3) {
          const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.0.0',
            meta: { target: ['sequence_number', 'venue_id'] },
          });
          throw p2002Error;
        }
        return { success: true, attempts };
      };

      const result = await withFiscalRetry(prisma, mockAction, 5);
      expect(result).toEqual({ success: true, attempts: 3 });
      expect(attempts).toBe(3);
    });

    it('re-throws P2002 error after maxRetries exceeded on persistent P2002 collision', async () => {
      let attempts = 0;
      const mockAction = async (tx: Prisma.TransactionClient) => {
        attempts++;
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['fiscal_logs_venue_id_sequence_number_key'] },
        });
      };

      await expect(withFiscalRetry(prisma, mockAction, 4)).rejects.toThrow(
        Prisma.PrismaClientKnownRequestError
      );
      expect(attempts).toBe(4);
    });

    it('does NOT retry on non-P2002 errors and re-throws immediately on attempt 1', async () => {
      let attempts = 0;
      const mockAction = async (tx: Prisma.TransactionClient) => {
        attempts++;
        throw new Error('Database connection reset');
      };

      await expect(withFiscalRetry(prisma, mockAction, 5)).rejects.toThrow('Database connection reset');
      expect(attempts).toBe(1);
    });

    it('does NOT retry on P2002 error targeting non-fiscal table', async () => {
      let attempts = 0;
      const mockAction = async (tx: Prisma.TransactionClient) => {
        attempts++;
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['users_email_key'] },
        });
      };

      await expect(withFiscalRetry(prisma, mockAction, 5)).rejects.toThrow('Unique constraint failed');
      expect(attempts).toBe(1);
    });
  });

  describe('Database Stress Test: High Concurrency Void & Hash Chain Verification', () => {
    it('handles 10 concurrent void requests on the same venue without duplicate sequence numbers or broken hash chain', async () => {
      const venueId = 'v_stress_1';
      await prisma.venue.create({
        data: { id: venueId, name: 'Stress Venue' },
      });

      const sessionCount = 10;
      const sessionIds: string[] = [];

      for (let i = 0; i < sessionCount; i++) {
        const sessionId = `s_stress_${i}`;
        sessionIds.push(sessionId);
        await prisma.checkoutSession.create({
          data: {
            id: sessionId,
            venueId,
            status: 'paid',
            fiscalStatus: 'invoiced',
            totalAmount: 1000,
            digitalConsent: true,
            tickets: {
              create: {
                id: `t_stress_${i}`,
                venueId,
                productName: 'drink',
                price: 1000,
                priceSnapshot: 1000,
                vatRate: 10.0,
                status: 'valid',
              },
            },
          },
        });
      }

      // Fire 10 simultaneous void requests
      const promises = sessionIds.map((sessionId) =>
        app.fastify.inject({
          method: 'POST',
          url: '/api/session/void',
          headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
          payload: { sessionId, reason: 'errore_cassa', voidedById: 'u_stress', venueId },
        })
      );

      const results = await Promise.all(promises);

      // Verify HTTP responses
      for (const res of results) {
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      }

      // Query database FiscalLog entries sorted by sequence number
      const logs = await prisma.fiscalLog.findMany({
        where: { venueId },
        orderBy: { sequenceNumber: 'asc' },
      });

      expect(logs.length).toBe(sessionCount);

      // Verify strictly ascending sequence: 0..9
      const sequenceNumbers = logs.map((l) => l.sequenceNumber);
      expect(sequenceNumbers).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // Cryptographic Hash Chain Verification Oracle
      let expectedPreviousHash = GENESIS_HASH;
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        expect(log.previousHash).toBe(expectedPreviousHash);

        const computedHash = computeFiscalHash(
          {
            sequenceNumber: log.sequenceNumber,
            previousHash: log.previousHash,
            sessionId: log.sessionId,
            timestamp: log.timestamp.toISOString(),
            printerBrand: log.printerBrand,
            commandPayload: log.commandPayload,
            statusResponse: log.statusResponse,
            success: log.success,
            errorMessage: log.errorMessage,
          },
          process.env.JWT_SECRET || 'test-jwt-secret-32chars-aaaaaaaaaaaa'
        );

        expect(log.hash).toBe(computedHash);
        expectedPreviousHash = log.hash;
      }
    });

    it('maintains independent gapless sequences for multiple venues executing concurrent voids simultaneously', async () => {
      const venueA = 'v_multi_A';
      const venueB = 'v_multi_B';

      await prisma.venue.createMany({
        data: [
          { id: venueA, name: 'Venue A' },
          { id: venueB, name: 'Venue B' },
        ],
      });

      const sessionsA: string[] = [];
      const sessionsB: string[] = [];

      for (let i = 0; i < 5; i++) {
        const sA = `s_multi_A_${i}`;
        const sB = `s_multi_B_${i}`;
        sessionsA.push(sA);
        sessionsB.push(sB);

        await prisma.checkoutSession.create({
          data: {
            id: sA,
            venueId: venueA,
            status: 'paid',
            fiscalStatus: 'invoiced',
            totalAmount: 500,
          },
        });

        await prisma.checkoutSession.create({
          data: {
            id: sB,
            venueId: venueB,
            status: 'paid',
            fiscalStatus: 'invoiced',
            totalAmount: 500,
          },
        });
      }

      // Execute 5 voids for venue A and 5 voids for venue B simultaneously (10 concurrent requests)
      const allPromises = [
        ...sessionsA.map((sessionId) =>
          app.fastify.inject({
            method: 'POST',
            url: '/api/session/void',
            headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
            payload: { sessionId, reason: 'errore_cassa', voidedById: 'u1', venueId: venueA },
          })
        ),
        ...sessionsB.map((sessionId) =>
          app.fastify.inject({
            method: 'POST',
            url: '/api/session/void',
            headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
            payload: { sessionId, reason: 'errore_cassa', voidedById: 'u1', venueId: venueB },
          })
        ),
      ];

      const results = await Promise.all(allPromises);
      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }

      const logsA = await prisma.fiscalLog.findMany({
        where: { venueId: venueA },
        orderBy: { sequenceNumber: 'asc' },
      });

      const logsB = await prisma.fiscalLog.findMany({
        where: { venueId: venueB },
        orderBy: { sequenceNumber: 'asc' },
      });

      expect(logsA.map((l) => l.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
      expect(logsB.map((l) => l.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
    });
  });
});
