import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { createConfig, type AppConfig } from '../src/utils/config';
import { buildApp } from '../src/app';
import {
  getAcubeToken,
  voidAcubeReceipt,
} from '../src/utils/acubeClient';
import { ensureSessionInvoiced } from '../src/utils/fiscalReconciler';
import { createFakeIdentityProvider, type IdentityProvider } from '../src/utils/identityProvider';

export interface TestApp {
  fastify: FastifyInstance;
  prisma: PrismaClient;
  stripe: Stripe;
  config: AppConfig;
  identityProvider: IdentityProvider;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  stripeApiKey?: string;
  stripeSecretKey?: string;
  stripe?: Stripe;
  config?: Partial<AppConfig>;
  identityProvider?: IdentityProvider;
}

/**
 * Crea un'istanza Fastify di test riutilizzando la composition root `buildApp`.
 */
export async function createTestApp(
  prisma: PrismaClient,
  opts: TestAppOptions = {}
): Promise<TestApp> {
  const apiKey =
    opts.stripeApiKey ||
    opts.stripeSecretKey ||
    process.env.STRIPE_API_KEY ||
    process.env.STRIPE_SECRET_KEY ||
    'sk_test_placeholder';

  const fullConfig = createConfig({
    STRIPE_API_KEY: apiKey,
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_placeholder',
    JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-32-chars-long-aaaaaa',
    TICKET_JWT_SECRET: process.env.TICKET_JWT_SECRET || 'test-ticket-jwt-secret-32-chars-bbbbbb',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://sauta:sauta_dev_pass@localhost:5432/sauta_dev?schema=public',
    ADMIN_SECRET: process.env.ADMIN_SECRET || 'test-admin-secret-32chars-aaaaaaaaaaaaaa',
    NODE_ENV: 'test',
    PORT: '3001',
    BASE_URL: 'http://localhost:3001',
    ALLOWED_ORIGINS: 'http://localhost:5173',

    WORKOS_API_KEY: 'sk_test_workos_fake_key',
    WORKOS_CLIENT_ID: 'client_workos_fake_id',
    WORKOS_COOKIE_PASSWORD: 'test-workos-cookie-password-32-chars-long-aaaa',
    WORKOS_WEBHOOK_SECRET: 'whsec_workos_test_secret',
    WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
    WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
    CONSOLE_ORIGIN: 'http://console.localhost:3001',
    AUTH_AUDIT_HMAC_SECRET: 'test-auth-audit-hmac-secret-32-chars-bbbbb',
    PLATFORM_ROOT_DOMAIN: process.env.PLATFORM_ROOT_DOMAIN || 'sauta.test',
    ...opts.config,
  });

  const stripe =
    opts.stripe ??
    new Stripe(fullConfig.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    });

  const fakeIdProvider = opts.identityProvider || createFakeIdentityProvider();

  const fastify = await buildApp({
    config: fullConfig,
    prisma,
    stripe,
    identityProvider: fakeIdProvider,
    logger: false,
    fiscalServices: {
      ensureSessionInvoiced,
      getAcubeToken,
      voidAcubeReceipt,
    },
  });

  return {
    fastify,
    prisma,
    stripe,
    config: fullConfig,
    identityProvider: fakeIdProvider,
    close: async () => {
      await fastify.close();
    },
  };
}
