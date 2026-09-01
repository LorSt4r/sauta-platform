import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';
import { createPrismaClient } from '../../src/utils/prisma';

describe('Health endpoint [Wave 5]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = createPrismaClient(db.url);
    await prisma.$connect();
    app = await createTestApp(prisma);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  it('GET /ping ritorna { status: ok, service }', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toMatch(/Sauta/i);
  });

  it('GET /health ritorna status ok, uptime e database status ok con latenza', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.database).toBeDefined();
    expect(body.database.status).toBe('ok');
    expect(typeof body.database.latencyMs).toBe('number');
  });

  it('GET /health ritorna 500 se la query di readiness fallisce', async () => {
    const unavailablePrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$queryRaw') {
          return () => Promise.reject(new Error('Database unavailable'));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const unavailableApp = await createTestApp(unavailablePrisma);

    const res = await unavailableApp.fastify.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('error');
    expect(body.database.status).toBe('down');

    await unavailableApp.close();
  });
});
