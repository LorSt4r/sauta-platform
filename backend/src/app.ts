import Fastify, { FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rawBody from 'fastify-raw-body';
import path from 'path';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { type AppConfig } from './utils/config';
import {
  registerStripeRoutes,
  type StripeFiscalServices,
} from './routes/stripe';
import { registerAdminRoutes } from './routes/admin';
import { createTenantResolver, registerTenantResolver } from './utils/tenantResolver';
import { AppError } from './errors/AppError';
import { type IdentityProvider } from './utils/identityProvider';
import { registerAuthRoutes } from './routes/authRoutes';
import { registerWorkosWebhookRoutes } from './routes/workosWebhookRoutes';
import { registerPlatformOnboardingRoutes } from './routes/platformOnboardingRoutes';
import { registerConsoleOnboardingRoutes } from './routes/consoleOnboardingRoutes';
import { isFingerprintAssetPath, parseHostAuthority } from './utils/hostAuthority';

export interface AppDependencies {
  config: AppConfig;
  prisma: PrismaClient;
  stripe: Stripe;
  logger: NonNullable<FastifyServerOptions['logger']>;
  fiscalServices: StripeFiscalServices;
  identityProvider: IdentityProvider; // OBBLIGATORIO dalla Composition Root
}

/**
 * Composition Root Sauta: costruisce e configura l'applicazione Fastify
 * senza effettuare listen() e senza accedere implicitamente alle variabili d'ambiente.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, prisma, stripe, identityProvider } = deps;

  if (config.IS_PRODUCTION && config.TRUST_PROXY === true) {
    throw new Error('[CONFIG] TRUST_PROXY=true globale è rifiutato in produzione. Usa false o un numero esplicito di hop fidati (es. 1).');
  }

  const fastify = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger: deps.logger,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // Error handler globale: sanitizza risposte e messaggi di errore
  fastify.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { statusCode?: number; message?: string; validation?: unknown };

    // 1. Errori applicativi pubblici (es. AppError con isPublic = true)
    if (error instanceof AppError && error.isPublic) {
      request.log.warn({ err: error }, `AppError (${error.statusCode}): ${error.message}`);
      return reply.status(error.statusCode).send({ error: error.message });
    }

    // 2. Errori di validazione nativi Fastify (es. schema body/params)
    if (err.validation) {
      request.log.warn({ err: error }, 'Errore di validazione Fastify');
      return reply.status(err.statusCode || 400).send({ error: err.message || 'Errore di validazione' });
    }

    const statusCode =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;

    // 3. Errori server 5xx o non gestiti
    if (statusCode === 500) {
      request.log.error({ err: error }, 'Errore interno del server non gestito');
      return reply.status(500).send({ error: 'Errore interno del server' });
    }

    // 4. Errori 4xx da provider (es. Stripe/A-Cube) o non esplicitamente pubblici: sanitizzazione
    request.log.warn({ err: error }, 'Errore 4xx sanitizzato');
    return reply.status(statusCode).send({ error: 'Richiesta non valida' });
  });

  // Cache-Control Policy Hook (REVERSE_PROXY_CONTRACT.md & R5)
  fastify.addHook('onSend', async (request, reply) => {
    const url = request.raw.url || '';
    if (reply.statusCode === 200 && isFingerprintAssetPath(url)) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
  });

  // Plugin di sistema
  await fastify.register(rawBody, { runFirst: true });
  await fastify.register(compress, { global: true });
  await fastify.register(fastifyCookie, {
    secret: config.WORKOS_COOKIE_PASSWORD,
  });

  const corsOrigins = Array.from(
    new Set([...config.ALLOWED_ORIGINS, config.CONSOLE_ORIGIN].filter(Boolean))
  );
  if (corsOrigins.includes('*')) {
    throw new Error('[CONFIG] CORS wildcard non consentita con credenziali.');
  }

  await fastify.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  fastify.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !corsOrigins.includes(origin)) {
      reply.removeHeader('access-control-allow-credentials');
    }
  });
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
  });
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://js.stripe.com'],
        scriptSrcAttr: ["'none'"],
        frameSrc: ["'self'", 'https://js.stripe.com'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  });

  // Registrazione tenant resolver (hostname-based multi-tenancy)
  const tenantResolver = createTenantResolver({
    prisma,
    config,
    isProduction: config.IS_PRODUCTION,
  });
  await registerTenantResolver(fastify, tenantResolver);

  const isKnownUiAuthority = async (rawHost: string | undefined): Promise<boolean> => {
    const authority = parseHostAuthority(rawHost, config);
    if (!authority.isValid || authority.type === 'UNKNOWN') return false;
    if (authority.type === 'CONSOLE') return true;
    if (authority.type === 'PLATFORM_ROOT') return false;
    return (await tenantResolver.resolveTenant(rawHost)) !== null;
  };

  // Registrazione rotte API Sauta PWA, Stripe & Admin
  await fastify.register(registerStripeRoutes, {
    prisma,
    stripe,
    config,
    fiscalServices: deps.fiscalServices,
  });
  await fastify.register(registerAdminRoutes, { prisma, stripe, config });

  // Registrazione rotte AuthKit, Console, Onboarding & WorkOS Webhook (Wave 9C.0C)
  await fastify.register(registerAuthRoutes, { prisma, config, identityProvider });
  await fastify.register(registerWorkosWebhookRoutes, { prisma, config, identityProvider });
  await fastify.register(registerPlatformOnboardingRoutes, { prisma, config, identityProvider });
  await fastify.register(registerConsoleOnboardingRoutes, { prisma, config, identityProvider });

  // Endpoint di utilità e health check
  fastify.get('/ping', async () => ({ status: 'ok', service: 'Sauta Backend' }));

  fastify.get('/health', async (req, reply) => {
    try {
      const start = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      const end = performance.now();
      const latencyMs = Math.round(end - start);
      return {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        database: {
          status: 'ok',
          latencyMs,
        },
      };
    } catch (err) {
      reply.status(500).send({
        status: 'error',
        database: {
          status: 'down',
        },
      });
    }
  });

  // Server statico per il frontend Vite (PWA + Console)
  const frontendPath = path.join(__dirname, '../../frontend/dist');
  fastify.addHook('preHandler', async (request, reply) => {
    const url = request.raw.url || '';
    if (
      request.method === 'GET' &&
      url.startsWith('/assets/') &&
      !(await isKnownUiAuthority(request.headers.host))
    ) {
      return reply.status(404).send({ error: 'Not Found' });
    }
  });
  await fastify.register(fastifyStatic, {
    root: frontendPath,
    prefix: '/',
    index: false,
    allowedPath: (pathName, _root, request) => {
      const hostAuth = parseHostAuthority(request.headers.host, config);
      if (!hostAuth.isValid || hostAuth.type === 'UNKNOWN') {
        return false;
      }
      const requestedFile = pathName.replace(/^\/+/, '');
      if (requestedFile === 'console.html') {
        return hostAuth.type === 'CONSOLE';
      }
      if (requestedFile === 'index.html') {
        return hostAuth.type !== 'CONSOLE';
      }
      return true;
    },
  });

  fastify.get('/', async (request, reply) => {
    const hostAuth = parseHostAuthority(request.headers.host, config);
    if (!hostAuth.isValid || hostAuth.type === 'UNKNOWN') {
      return reply.status(404).send({ error: 'Not Found' });
    }
    if (hostAuth.type === 'CONSOLE') {
      return reply.sendFile('console.html');
    }
    if (await isKnownUiAuthority(request.headers.host)) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not Found' });
  });

  fastify.get('/console', async (request, reply) => {
    const hostAuth = parseHostAuthority(request.headers.host, config);
    if (hostAuth.isValid && hostAuth.type === 'CONSOLE') {
      return reply.sendFile('console.html');
    }
    return reply.status(404).send({ error: 'Not Found' });
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    const { method, url } = request;
    const hostAuth = parseHostAuthority(request.headers.host, config);
    if (!hostAuth.isValid || hostAuth.type === 'UNKNOWN') {
      return reply.status(404).send({ error: 'Not Found', message: `Route ${method}:${url} not found` });
    }
    if (method === 'GET' && !url.startsWith('/api')) {
      const hasFileExtension = /\.[a-z0-9]+$/i.test(url);
      if (!hasFileExtension) {
        if (hostAuth.type === 'CONSOLE') {
          return reply.sendFile('console.html');
        }
        if (await isKnownUiAuthority(request.headers.host)) {
          return reply.sendFile('index.html');
        }
        return reply.status(404).send({ error: 'Not Found', message: `Route ${method}:${url} not found` });
      }
    }
    return reply.status(404).send({ error: 'Not Found', message: `Route ${method}:${url} not found` });
  });

  return fastify;
}
