import 'dotenv/config';
import Stripe from 'stripe';
import { createConfig } from './utils/config';
import { createPrismaClient } from './utils/prisma';
import {
  ensureSessionInvoiced,
  startFiscalReconciler,
} from './utils/fiscalReconciler';
import { buildApp } from './app';
import {
  getAcubeToken,
  voidAcubeReceipt,
} from './utils/acubeClient';
import { createWorkosIdentityProvider } from './utils/identityProvider';
import { sanitizeRequestUrl } from './utils/logSanitizer';

async function start() {
  try {
    const cfg = createConfig();
    const prisma = createPrismaClient(cfg.DATABASE_URL);
    const stripe = new Stripe(cfg.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    });
    const identityProvider = createWorkosIdentityProvider(cfg);

    const fastify = await buildApp({
      config: cfg,
      prisma,
      stripe,
      identityProvider,
      logger: {
        level: 'info',
        serializers: {
          req(request) {
            const url = request.raw?.url || request.url || '';
            return {
              method: request.method,
              url: sanitizeRequestUrl(url),
              hostname: request.hostname,
            };
          },
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.headers["x-admin-secret"]',
          'req.headers["stripe-signature"]',
          'req.headers["workos-signature"]',
          'req.query.code',
          'req.query.state',
          'req.query.secret',
        ],
      },
      fiscalServices: {
        ensureSessionInvoiced,
        getAcubeToken,
        voidAcubeReceipt,
      },
    });

    const reconciler = startFiscalReconciler({
      prisma,
      isProduction: cfg.IS_PRODUCTION,
      logger: fastify.log,
    });

    const address = await fastify.listen({ port: cfg.PORT, host: '0.0.0.0' });
    fastify.log.info(`Server Sauta avviato su ${address}`);

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      fastify.log.info(`[Shutdown] Ricevuto ${signal}: avvio chiusura graceful...`);

      const forceExitTimer = setTimeout(() => {
        fastify.log.error('[Shutdown] Timeout 10s: uscita forzata.');
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref();

      (async () => {
        try {
          reconciler.stop();
          await fastify.close();
          await prisma.$disconnect();
          clearTimeout(forceExitTimer);
          fastify.log.info('[Shutdown] Chiusura completata (server HTTP + DB).');
          process.exit(0);
        } catch (err) {
          clearTimeout(forceExitTimer);
          fastify.log.error({ err }, '[Shutdown] Errore durante la chiusura.');
          process.exit(1);
        }
      })();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      fastify.log.error({ err: reason }, '[Process] Unhandled Rejection');
      shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      fastify.log.error({ err }, '[Process] Uncaught Exception');
      shutdown('uncaughtException');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'errore sconosciuto';
    process.stderr.write(`[Bootstrap Error] ${message}\n`);
    process.exit(1);
  }
}

start();
