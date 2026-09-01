import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';

describe('Void/Storno endpoint [FIX 2.3]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
    app = await createTestApp(prisma);
  }, 60000);

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

    // Seed venue + product + paid session
    await prisma.venue.create({
      data: {
        id: 'v1',
        name: 'Test Disco',
        products: {
          create: { id: 'p1', slug: 'vodka', name: 'Vodka', price: 1000, vatRate: 10.0 },
        },
      },
    });

    await prisma.venue.create({
      data: {
        id: 'v2',
        name: 'Test Disco 2',
        products: {
          create: { id: 'p2', slug: 'gin', name: 'Gin', price: 1000, vatRate: 10.0 },
        },
      },
    });

    // Create a paid session with invoiced fiscal status
    await prisma.checkoutSession.create({
      data: {
        id: 's1',
        venueId: 'v1',
        status: 'paid',
        fiscalStatus: 'invoiced',
        totalAmount: 1000,
        digitalConsent: true,
        tickets: {
          create: { id: 't1', venueId: 'v1', productName: 'vodka', price: 1000, priceSnapshot: 1000, vatRate: 10.0, status: 'valid' },
        },
      },
    });
  });

  it('rifiuta annullamento se credenziali non valide o mancanti', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'wrong-secret' },
      payload: { sessionId: 's1', reason: 'errore_cassa', voidedById: 'user1', venueId: 'v1' },
    });
    expect(res.statusCode).toBe(401);

    const res2 = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      payload: { sessionId: 's1', reason: 'errore_cassa', voidedById: 'user1', venueId: 'v1' },
    });
    expect(res2.statusCode).toBe(401);
  });

  it('annulla sessione same-day → voided + FiscalLog annullamento', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's1', reason: 'errore_cassa', voidedById: 'user1', venueId: 'v1' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.voidType).toBe('voided');

    // Verifica sessione aggiornata
    const session = await prisma.checkoutSession.findUnique({ where: { id: 's1' } });
    expect(session!.fiscalStatus).toBe('voided');
    expect(session!.voidedAt).not.toBeNull();
    expect(session!.voidedReason).toBe('errore_cassa');

    // Verifica ticket voided
    const ticket = await prisma.ticket.findUnique({ where: { id: 't1' } });
    expect(ticket!.status).toBe('voided');

    // Verifica FiscalLog creato
    const logs = await prisma.fiscalLog.findMany({ where: { sessionId: 's1' } });
    expect(logs.length).toBe(1);
    expect(logs[0].operationKind).toBe('annullamento');
    expect(logs[0].correlativeId).toBe('s1');
    expect(logs[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rifiuta annullamento senza sessionId', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { reason: 'errore_cassa', voidedById: 'u1', venueId: 'v1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rifiuta annullamento con reason non valido', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's1', reason: 'motivo_falso', voidedById: 'u1', venueId: 'v1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rifiuta annullamento sessione non trovata', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 'nonexistent', reason: 'errore_cassa', voidedById: 'u1', venueId: 'v1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rifiuta annullamento da venue sbagliato', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's1', reason: 'errore_cassa', voidedById: 'u1', venueId: 'v2' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rifiuta doppio annullamento (voided → voided non permesso)', async () => {
    // Primo annullamento
    await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's1', reason: 'errore_cassa', voidedById: 'u1', venueId: 'v1' },
    });

    // Secondo annullamento — deve fallire (voided → voided non permesso)
    const res2 = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's1', reason: 'altro', voidedById: 'u1', venueId: 'v1' },
    });
    expect(res2.statusCode).toBe(409);
  });

  it('rifiuta annullamento sessione pending (non ancora fatturata)', async () => {
    // Crea sessione pending
    await prisma.checkoutSession.create({
      data: {
        id: 's2',
        venueId: 'v1',
        status: 'pending',
        fiscalStatus: 'pending',
        totalAmount: 500,
      },
    });

    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/session/void',
      headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
      payload: { sessionId: 's2', reason: 'errore_cassa', voidedById: 'u1', venueId: 'v1' },
    });
    // pending → voided non permesso (deve passare per invoiced prima)
    expect(res.statusCode).toBe(409);
  });

  it('gestisce correttamente void concorrenti sulla stessa venue senza collisioni P2002', async () => {
    // Crea 5 sessioni in stato invoiced per la stessa venue v1
    const sessions = [];
    for (let i = 10; i < 15; i++) {
      const sessionId = `s_conc_${i}`;
      sessions.push(sessionId);
      await prisma.checkoutSession.create({
        data: {
          id: sessionId,
          venueId: 'v1',
          status: 'paid',
          fiscalStatus: 'invoiced',
          totalAmount: 1000,
          digitalConsent: true,
          tickets: {
            create: { id: `t_conc_${i}`, venueId: 'v1', productName: 'vodka', price: 1000, priceSnapshot: 1000, vatRate: 10.0, status: 'valid' },
          },
        },
      });
    }

    // Esegue 5 chiamate void in parallelo
    const promises = sessions.map((sessionId) =>
      app.fastify.inject({
        method: 'POST',
        url: '/api/session/void',
        headers: { 'X-Admin-Secret': 'test-admin-secret-32chars-aaaaaaaaaaaaaa' },
        payload: { sessionId, reason: 'errore_cassa', voidedById: 'u1', venueId: 'v1' },
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    }

    const logs = await prisma.fiscalLog.findMany({
      where: { venueId: 'v1' },
      orderBy: { sequenceNumber: 'asc' },
    });

    expect(logs.length).toBe(5);
    const seqs = logs.map((l) => l.sequenceNumber);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });
});
