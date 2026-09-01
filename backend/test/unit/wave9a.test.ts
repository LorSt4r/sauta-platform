import { describe, it, expect } from 'vitest';
import { createConfig } from '../../src/utils/config';
import { buildApp } from '../../src/app';
import { createPrismaClient } from '../../src/utils/prisma';
import { AppError } from '../../src/errors/AppError';
import Stripe from 'stripe';
import { spawnSync } from 'child_process';
import path from 'path';
import {
  getAcubeToken,
  voidAcubeReceipt,
} from '../../src/utils/acubeClient';
import { ensureSessionInvoiced } from '../../src/utils/fiscalReconciler';
import { createFakeIdentityProvider } from '../../src/utils/identityProvider';

describe('Wave 9A Requirements & Composition Root Tests', () => {
  const dummyEnv = {
    STRIPE_API_KEY: 'sk_test_1234567890abcdef',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_1234567890abcdef',
    STRIPE_WEBHOOK_SECRET: 'whsec_1234567890abcdef',
    JWT_SECRET: 'test_jwt_secret_32_chars_long_aaaaaa',
    TICKET_JWT_SECRET: 'test_ticket_jwt_secret_32_chars_bbbbbb',
    DATABASE_URL: 'postgresql://sauta:sauta@localhost:5432/sauta_test',
    ADMIN_SECRET: 'admin_secret_32_chars_long_aaaaaaa',
    NODE_ENV: 'test',
    WORKOS_API_KEY: 'sk_test_workos_key_dummy',
    WORKOS_CLIENT_ID: 'client_workos_id_dummy',
    WORKOS_COOKIE_PASSWORD: 'test_workos_cookie_password_32_chars_long_aaaaa',
    WORKOS_WEBHOOK_SECRET: 'whsec_workos_secret_dummy',
    WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
    WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
    CONSOLE_ORIGIN: 'http://console.localhost:3001',
    AUTH_AUDIT_HMAC_SECRET: 'test_auth_audit_hmac_secret_32_chars_long_bbbbb',
    PLATFORM_ROOT_DOMAIN: 'sauta.test',
  };

  it('1. Unit test createConfig senza env a import-time', () => {
    const config = createConfig(dummyEnv);
    expect(config.STRIPE_API_KEY).toBe(dummyEnv.STRIPE_API_KEY);
    expect(config.ADMIN_SECRET).toBe(dummyEnv.ADMIN_SECRET);
    expect(config.NODE_ENV).toBe('test');
  });

  it('2. Importa ogni route senza env globale', async () => {
    const backendRoot = path.resolve(__dirname, '../..');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        "Promise.all([import('./src/routes/stripe.ts'), import('./src/routes/admin.ts'), import('./src/routes/authRoutes.ts'), import('./src/routes/workosWebhookRoutes.ts'), import('./src/routes/platformOnboardingRoutes.ts'), import('./src/routes/consoleOnboardingRoutes.ts')])",
      ],
      {
        cwd: backendRoot,
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      }
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('3. buildApp registra error handler, CSP, rate limit e rotte', async () => {
    const cfg = createConfig(dummyEnv);
    const prisma = createPrismaClient(cfg.DATABASE_URL);
    const stripe = new Stripe(cfg.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    });
    const identityProvider = createFakeIdentityProvider();

    const app = await buildApp({
      config: cfg,
      prisma,
      stripe,
      identityProvider,
      logger: false,
      fiscalServices: {
        ensureSessionInvoiced,
        getAcubeToken,
        voidAcubeReceipt,
      },
    });

    // Verifichiamo che le rotte standard rispondano
    const pingRes = await app.inject({ method: 'GET', url: '/ping' });
    expect(pingRes.statusCode).toBe(200);
    expect(pingRes.json()).toEqual({ status: 'ok', service: 'Sauta Backend' });

    const configRes = await app.inject({ method: 'GET', url: '/api/config' });
    expect(configRes.statusCode).toBe(200);
    expect(configRes.json()).toEqual({ stripePublishableKey: dummyEnv.STRIPE_PUBLISHABLE_KEY });

    // Verifichiamo la presenza dell'header Content-Security-Policy (Helmet)
    expect(configRes.headers['content-security-policy']).toBeDefined();

    await app.close();
  });

  it('4. Sanitizzazione: errore interno 400 o da dipendenza esterna non espone il messaggio sensibile', async () => {
    const cfg = createConfig(dummyEnv);
    const prisma = createPrismaClient(cfg.DATABASE_URL);
    const stripe = new Stripe(cfg.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    });
    const identityProvider = createFakeIdentityProvider();

    const app = await buildApp({
      config: cfg,
      prisma,
      stripe,
      identityProvider,
      logger: false,
      fiscalServices: {
        ensureSessionInvoiced,
        getAcubeToken,
        voidAcubeReceipt,
      },
    });

    // Registriamo una rotta di test che lancia un errore interno 400 sanitizzato (non AppError pubblico)
    app.get('/test/internal-400', async () => {
      const err = Object.assign(
        new Error('Secret provider database key leak details internal 400'),
        { statusCode: 400 }
      );
      throw err;
    });

    // E una rotta che lancia un AppError pubblico
    app.get('/test/public-400', async () => {
      throw new AppError('Messaggio di errore valido per il client', 400, true);
    });

    const internalRes = await app.inject({ method: 'GET', url: '/test/internal-400' });
    expect(internalRes.statusCode).toBe(400);
    expect(internalRes.json()).toEqual({ error: 'Richiesta non valida' });
    expect(internalRes.body).not.toContain('Secret provider database key leak');

    const publicRes = await app.inject({ method: 'GET', url: '/test/public-400' });
    expect(publicRes.statusCode).toBe(400);
    expect(publicRes.json()).toEqual({ error: 'Messaggio di errore valido per il client' });

    await app.close();
  });
});
