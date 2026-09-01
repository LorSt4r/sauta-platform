import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupE2eTest, cleanupE2eTest, createE2eVenue } from './e2e-helper';
import { PrismaClient } from '@prisma/client';
import { generateWalletToken, hashWalletToken } from '../../src/utils/capability';

describe('Digital Receipt Consent E2E Tests', () => {
  let app: any;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    const setup = await setupE2eTest();
    app = setup.app;
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  // TIER 1: Functional Verification
  describe('Tier 1: Functional Verification', () => {
    it('should allow checkout when digitalConsent is true', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 1',
        products: {
          create: [{ slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: { 'gin-tonic': 1 },
          digitalConsent: true,
        }),
      });

      expect(response.status).toBe(200);
      const data: any = await response.json();
      expect(data.sessionId).toBeDefined();
    });

    it('should store a high-resolution UTC timestamp in checkout session on consent', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 2',
        products: {
          create: [{ slug: 'negroni', name: 'Negroni', price: 1000 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: { 'negroni': 1 },
          digitalConsent: true,
        }),
      });

      const data: any = await response.json();
      const sessionId = data.sessionId;

      const sessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );

      const session = sessions[0];
      const consentTimestamp = session.digital_consent_timestamp ?? session.digitalConsentTimestamp;
      expect(consentTimestamp).toBeDefined();
      expect(consentTimestamp).not.toBeNull();

      const timestampMs = new Date(consentTimestamp).getTime();
      expect(timestampMs).toBeGreaterThan(0);
      expect(Math.abs(Date.now() - timestampMs)).toBeLessThan(10000);
    });

    it('should display printable digital receipt if consent was provided', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 3',
        products: {
          create: [{ slug: 'spritz', name: 'Spritz', price: 600 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 600,
          items: { 'spritz': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      const response = await fetch(`${baseUrl}/api/wallet/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token: checkoutData.walletToken }),
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Documento Commerciale');
      expect(html).toContain('Spritz');
    });

    it('should verify digitalConsent column in database is a boolean type', async () => {
      const columns = await prisma.$queryRawUnsafe<any[]>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'checkout_sessions' AND column_name = 'digital_consent'`
      );
      expect(columns.length).toBe(1);
      expect(columns[0].data_type).toBe('boolean');
    });

    it('should verify digital_consent_timestamp column in database is a timestamp type', async () => {
      const columns = await prisma.$queryRawUnsafe<any[]>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'checkout_sessions' AND column_name = 'digital_consent_timestamp'`
      );
      expect(columns.length).toBe(1);
      expect(columns[0].data_type).toContain('timestamp');
    });

    it('should maintain the digital consent timestamp through payment confirmations', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 4',
        products: {
          create: [{ slug: 'mojito', name: 'Mojito', price: 900 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 900,
          items: { 'mojito': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      const beforeSessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      const initialTimestamp = beforeSessions[0].digital_consent_timestamp ?? beforeSessions[0].digitalConsentTimestamp;

      // Confirm checkout
      await fetch(`${baseUrl}/api/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
      });

      const afterSessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      const postTimestamp = afterSessions[0].digital_consent_timestamp ?? afterSessions[0].digitalConsentTimestamp;
      expect(postTimestamp).toEqual(initialTimestamp);
    });
  });

  // TIER 2: Boundary & Error Conditions
  describe('Tier 2: Boundary & Error Conditions', () => {
    it('should reject checkout when digitalConsent is false', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 5',
        products: {
          create: [{ slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: { 'gin-tonic': 1 },
          digitalConsent: false,
        }),
      });

      expect(response.status).toBe(400);
      const data: any = await response.json();
      expect(data.error).toContain('Consenso allo scontrino digitale obbligatorio');
    });

    it('should reject checkout when digitalConsent is missing', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 6',
        products: {
          create: [{ slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 }],
        },
      });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: { 'gin-tonic': 1 },
        }),
      });

      expect(response.status).toBe(400);
      const data: any = await response.json();
      expect(data.error).toBeDefined();
    });

    it('should deny receipt retrieval if digitalConsent was not stored as true', async () => {
      const venue = await createE2eVenue(prisma, { name: 'Consent Venue 7' });

      // Manually insert checkout session with digitalConsent: false
      const session = await prisma.checkoutSession.create({
        data: {
          venueId: venue.id,
          totalAmount: 1000,
          digitalConsent: false,
          status: 'paid',
        },
      });

      const walletToken = generateWalletToken();
      await prisma.walletCapability.create({
        data: {
          sessionId: session.id,
          tokenHash: hashWalletToken(walletToken),
        },
      });

      const response = await fetch(`${baseUrl}/api/wallet/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, token: walletToken }),
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain('Consenso digitale non fornito');
    });

    it('should reject checkout with string "true" value for digitalConsent', async () => {
      const venue = await createE2eVenue(prisma, { name: 'Consent Venue 8' });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: {},
          digitalConsent: 'true',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should reject checkout with integer 1 value for digitalConsent', async () => {
      const venue = await createE2eVenue(prisma, { name: 'Consent Venue 9' });

      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 1000,
          items: {},
          digitalConsent: 1,
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should keep the original digital consent timestamp unmodified on session voiding', async () => {
      const venue = await createE2eVenue(prisma, {
        name: 'Consent Venue 10',
        products: {
          create: [{ slug: 'cuba-libre', name: 'Cuba Libre', price: 800 }],
        },
      });

      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: 800,
          items: { 'cuba-libre': 1 },
          digitalConsent: true,
        }),
      });
      const checkoutData: any = await checkoutRes.json();
      const sessionId = checkoutData.sessionId;

      // Confirm
      await fetch(`${baseUrl}/api/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: `mock_${sessionId}` }),
      });

      // Manually set fiscalStatus to 'invoiced' to simulate receipt printed by RT
      await prisma.checkoutSession.update({
        where: { id: sessionId },
        data: { fiscalStatus: 'invoiced' },
      });

      // Get initial timestamp
      const beforeSessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      const initialTimestamp = beforeSessions[0].digital_consent_timestamp ?? beforeSessions[0].digitalConsentTimestamp;

      // Void the session
      await fetch(`${baseUrl}/api/session/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          reason: 'altro',
          voidedById: 'user_admin_1',
          venueId: venue.id,
        }),
      });

      // Verify timestamp is unchanged
      const afterSessions = await prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM checkout_sessions WHERE id = $1',
        sessionId
      );
      const postTimestamp = afterSessions[0].digital_consent_timestamp ?? afterSessions[0].digitalConsentTimestamp;
      expect(postTimestamp).toEqual(initialTimestamp);
    });
  });
});
