import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupE2eTest, cleanupE2eTest, createE2eVenue } from './e2e-helper';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../../src/utils/jwt';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('Real-World Scenarios E2E Tests (Tier 4)', () => {
  let app: any;
  let prisma: PrismaClient;
  let baseUrl: string;
  let adminSecret = process.env.ADMIN_SECRET || 'test-admin-secret-32chars-aaaaaaaaaaaaaa';

  beforeAll(async () => {
    const setup = await setupE2eTest();
    app = setup.app;
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  it('Scenario 1: Legacy mocked merchant onboarding route flow', async () => {
    // 1. Admin creates a new venue
    const venue = await createE2eVenue(prisma, { name: 'E2E Scenario Venue' });

    // 2. Admin starts Stripe Connect onboarding with businessType company
    const onboardRes = await fetch(`${baseUrl}/api/onboard-venue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': adminSecret,
      },
      body: JSON.stringify({
        venueId: venue.id,
        country: 'IT',
        businessType: 'company',
      }),
    });
    expect(onboardRes.status).toBe(200);
    const onboardData: any = await onboardRes.json();
    const accountId = onboardData.accountId;

    // 3. User finishes Stripe form and Stripe sends webhook account.updated
    const webhookRes = await fetch(`${baseUrl}/api/webhook/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'invalid_sig_fails_in_e2e_expected',
      },
      body: JSON.stringify({
        id: 'evt_onboard_complete',
        type: 'account.updated',
        data: {
          object: {
            id: accountId,
            charges_enabled: true,
            payouts_enabled: true,
          },
        },
      }),
    });
    expect(webhookRes.status).toBe(400);

    // 4. Admin checks the callback return_url /onboarded endpoint manually to verify and finalize status
    const callbackRes = await fetch(`${baseUrl}/api/admin/venues/${venue.id}/onboarded`, {
      method: 'GET',
      headers: {
        'X-Admin-Secret': adminSecret,
      },
    });
    expect(callbackRes.status).toBe(200);
    const callbackData: any = await callbackRes.json();
    expect(callbackData.success).toBe(true);

    // 5. Verify database states
    const finalVenue = await prisma.venue.findUnique({ where: { id: venue.id } });
    expect(finalVenue?.stripeAccountId).toBe(accountId);
  });

  it('Scenario 2: Guest Checkout, Receipt Consent, and Swipe to Consume Flow', async () => {
    // 1. Setup venue and active products
    const venue = await createE2eVenue(prisma, {
      name: 'Scenario Club',
      products: {
        create: [
          { slug: 'negroni', name: 'Negroni', price: 900, vatRate: 10.0 },
          { slug: 'vodka-redbull', name: 'Vodka Redbull', price: 1000, vatRate: 10.0 },
        ],
      },
    });

    // 2. Customer performs a guest checkout ordering 1 Negroni and 1 Vodka Redbull with consent
    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 1900,
        items: { 'negroni': 1, 'vodka-redbull': 1 },
        digitalConsent: true,
      }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkoutData: any = await checkoutRes.json();
    const sessionId = checkoutData.sessionId;
    const walletToken = checkoutData.walletToken;

    // Verify guest email is not persisted to DB
    const [session] = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM checkout_sessions WHERE id = $1',
      sessionId
    );
    expect(session.email).toBeNull();

    // Verify digital consent timestamp exists
    const consentTimestamp = session.digital_consent_timestamp ?? session.digitalConsentTimestamp;
    expect(consentTimestamp).toBeDefined();

    // 3. Confirm checkout payment
    const confirmRes = await fetch(`${baseUrl}/api/checkout/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmData: any = await confirmRes.json();
    expect(confirmData.success).toBe(true);
    expect(confirmData.tickets.length).toBe(2);

    // 4. Swipe to consume the first drink
    const negroniTicket = confirmData.tickets.find((t: any) => t.productName.toLowerCase() === 'negroni');
    const consumeTokenResponse = await fetch(`${baseUrl}/api/wallet/consume-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        token: walletToken,
        ticketId: negroniTicket.id,
      }),
    });
    const { consumeToken } = await consumeTokenResponse.json() as { consumeToken: string };
    const consumeRes = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });
    expect(consumeRes.status).toBe(200);

    // 5. Verify first ticket is used, second ticket remains valid
    const t1 = await prisma.ticket.findUnique({ where: { id: negroniTicket.id } });
    const vodkaTicket = confirmData.tickets.find((t: any) => t.productName.toLowerCase() === 'vodka redbull');
    const t2 = await prisma.ticket.findUnique({ where: { id: vodkaTicket.id } });
    expect(t1?.status).toBe('used');
    expect(t2?.status).toBe('valid');
  });

  it('Scenario 3: POS Void, Refund, and Tamper-Evident Fiscal Logging Flow', async () => {
    const venue = await createE2eVenue(prisma, {
      name: 'Scenario Bar',
      products: {
        create: [{ slug: 'mojito', name: 'Mojito', price: 800 }],
      },
    });

    // 1. Create a paid session
    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 800,
        items: { 'mojito': 1 },
        digitalConsent: true,
      }),
    });
    const checkoutData: any = await checkoutRes.json();
    const sessionId = checkoutData.sessionId;

    await fetch(`${baseUrl}/api/checkout/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
    });

    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { fiscalStatus: 'invoiced' },
    });

    // 2. Admin voids the checkout session
    const voidRes = await fetch(`${baseUrl}/api/session/void`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': adminSecret,
      },
      body: JSON.stringify({
        sessionId,
        reason: 'altro',
        voidedById: 'user_bartender_1',
        venueId: venue.id,
      }),
    });
    expect(voidRes.status).toBe(200);
    const voidData: any = await voidRes.json();
    expect(voidData.success).toBe(true);

    // 3. Verify session & ticket status in DB are 'voided'
    const dbSession = await prisma.checkoutSession.findUnique({ where: { id: sessionId }, include: { tickets: true } });
    expect(dbSession?.fiscalStatus).toBe(voidData.voidType);
    expect(dbSession?.tickets[0].status).toBe('voided');

    // 4. Verify that a fiscal log entry is generated and has a valid hash chain signature
    const logs = await prisma.fiscalLog.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'desc' },
    });
    expect(logs.length).toBeGreaterThan(0);
    const lastLog = logs[0];
    expect(lastLog.operationKind).toBe('annullamento');
    expect(lastLog.hash).toBeDefined();
    expect(lastLog.hash.length).toBeGreaterThan(0);
  });

  it('Scenario 4: DevOps Database Backup Utility Contract', async () => {
    const rootPath = path.resolve(__dirname, '../../../');
    const backupScriptPath = path.join(rootPath, 'scripts/backup.sh');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sauta-backup-e2e-'));
    const backupDir = path.join(tempRoot, 'backups');
    const fakeBin = path.join(tempRoot, 'bin');
    const pgDumpArgsFile = path.join(tempRoot, 'pg-dump-args.txt');
    const pgDumpDatabaseFile = path.join(tempRoot, 'pg-dump-database.txt');
    const fakePgDumpPath = path.join(fakeBin, 'pg_dump');

    try {
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(
        fakePgDumpPath,
        [
          '#!/usr/bin/env bash',
          'printf \'%s\\n\' "$@" >"${SAUTA_PGDUMP_ARGS_FILE:?}"',
          'printf \'%s\\n\' "${PGDATABASE:?}" >"${SAUTA_PGDUMP_DATABASE_FILE:?}"',
          'printf \'%s\\n\' \'-- PostgreSQL database dump\'',
        ].join('\n'),
        { mode: 0o700 },
      );

      execFileSync('/bin/bash', [backupScriptPath], {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://backup_user:test@example.invalid:5432/sauta?schema=public',
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          SAUTA_BACKUP_DIR: backupDir,
          SAUTA_BACKUP_RETENTION_DAYS: '30',
          SAUTA_PGDUMP_ARGS_FILE: pgDumpArgsFile,
          SAUTA_PGDUMP_DATABASE_FILE: pgDumpDatabaseFile,
        },
        stdio: 'pipe',
      });

      const files = fs.readdirSync(backupDir);
      const archives = files.filter((file) => file.endsWith('.sql.gz'));
      const checksums = files.filter((file) => file.endsWith('.sql.gz.sha256'));
      expect(archives).toHaveLength(1);
      expect(checksums).toEqual([`${archives[0]}.sha256`]);
      expect(fs.statSync(path.join(backupDir, archives[0])).size).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(backupDir, checksums[0]), 'utf8')).toContain(archives[0]);

      const pgDumpArgs = fs.readFileSync(pgDumpArgsFile, 'utf8');
      expect(pgDumpArgs).toContain('--no-owner');
      expect(pgDumpArgs).toContain('--no-privileges');
      expect(pgDumpArgs).not.toContain('postgresql://');
      expect(fs.readFileSync(pgDumpDatabaseFile, 'utf8').trim())
        .toBe('postgresql://backup_user:test@example.invalid:5432/sauta');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('Scenario 5: Multi-Venue Isolation & Security Boundaries', async () => {
    // 1. Create Venue A (primary domain demo.localhost)
    const venueA = await createE2eVenue(prisma, { name: 'Venue A' });

    // Create Venue B with custom hostname venue-b.localhost
    const venueB = await prisma.venue.create({
      data: {
        name: 'Venue B',
        isActive: true,
        domains: {
          create: {
            hostname: 'venue-b.localhost',
            type: 'PLATFORM',
            status: 'VERIFIED',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        },
      },
    });

    // Seed products
    await prisma.product.create({ data: { venueId: venueA.id, slug: 'gin', name: 'Gin', price: 1000 } });
    await prisma.product.create({ data: { venueId: venueB.id, slug: 'beer', name: 'Beer', price: 500 } });

    // 2. Customer orders drink for Venue B while on Venue A host (demo.localhost)
    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 500,
        items: { 'beer': 1 }, // Beer is only valid for Venue B
        digitalConsent: true,
      }),
    });
    // Should fail because Beer product doesn't exist for Venue A (demo.localhost)
    expect(checkoutRes.status).toBe(400);

    // 3. User obtains a ticket token for Venue A
    const validCheckout = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: 1000,
        items: { 'gin': 1 },
        digitalConsent: true,
      }),
    });
    const checkoutData: any = await validCheckout.json();
    const sessionId = checkoutData.sessionId;

    await fetch(`${baseUrl}/api/checkout/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
    });

    const tickets = await prisma.ticket.findMany({ where: { sessionId } });
    const forgedConsumeToken = signToken(
      { ticketId: tickets[0].id, venueId: venueB.id },
      process.env.TICKET_JWT_SECRET!,
      { expiresIn: '5m', audience: 'consume', subject: tickets[0].id }
    );

    const consumeRes = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken: forgedConsumeToken }),
    });
    expect(consumeRes.status).toBe(409);
  });

  it('Scenario 6: Prisma reconnects after an intentional client disconnect', async () => {
    let healthRes = await fetch(`${baseUrl}/health`, { method: 'GET' });
    expect(healthRes.status).toBe(200);

    await prisma.$disconnect();

    healthRes = await fetch(`${baseUrl}/health`, { method: 'GET' });
    expect(healthRes.status).toBe(200);
  });
});
