import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from '../helpers';
import { startTestDb, type TestDbHandle } from '../db';

describe('CSP Headers [Wave 4]', () => {
  let db: TestDbHandle;
  let prisma: PrismaClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
    await prisma.$connect();
    // createTestApp con CSP abilitato (non disabilitato come di default nei test)
    app = await createTestApp(prisma);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db?.stop();
  });

  it('ogni risposta ha content-security-policy header', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('CSP contiene default-src self', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
  });

  it('CSP contiene base-uri self', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("base-uri 'self'");
  });

  it('CSP contiene form-action self', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("form-action 'self'");
  });

  it('CSP permette Stripe script', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://js.stripe.com');
  });
});
