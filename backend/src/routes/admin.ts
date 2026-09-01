import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { prisma as globalPrisma } from '../utils/prisma';
import { type AppConfig, config as globalConfig } from '../utils/config';
import { safeSecretEqual } from '../utils/secrets';

export interface AdminRouteDeps {
  prisma: PrismaClient;
  stripe: Stripe;
  config: AppConfig;
}

/**
 * [FIX 3.5] Auth admin: header X-Admin-Secret deve matchare ADMIN_SECRET env.
 */
export function checkAdminAuth(req: FastifyRequest, adminSecret: string): boolean {
  const headerSecret = req.headers['x-admin-secret'];
  const provided = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;
  // [FIX B] confronto timing-safe: `===` leak-a il prefisso via timing attack
  return safeSecretEqual(provided, adminSecret);
}

/**
 * Factory testabile: registra route admin (Stripe Connect management).
 */
export async function registerAdminRoutes(
  fastify: FastifyInstance,
  deps: AdminRouteDeps
) {
  const { prisma, stripe, config: cfg } = deps;

  // [FIX 3.1] Onboard-venue: crea Connected Account + ritorna Account Link
  fastify.post('/api/onboard-venue', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminAuth(req, cfg.ADMIN_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized: missing or invalid X-Admin-Secret' });
    }

    try {
      const { venueId, email, country, businessType } = req.body as {
        venueId: string;
        email?: string;
        country?: string;
        businessType?: string;
      };

      if (!venueId) {
        return reply.status(400).send({ error: 'venueId mancante' });
      }

      if (businessType !== undefined) {
        if (businessType !== 'individual' && businessType !== 'company') {
          return reply.status(400).send({ error: 'businessType non valido. Deve essere "individual" o "company"' });
        }
      }

      const resolvedBusinessType: 'individual' | 'company' = (businessType === undefined || businessType === null) ? 'company' : (businessType as any);

      const venue = await prisma.venue.findUnique({ where: { id: venueId } });
      if (!venue) {
        return reply.status(404).send({ error: 'Venue non trovato' });
      }

      if (venue.stripeAccountId) {
        return reply.status(409).send({ error: 'Venue già onboardato', stripeAccountId: venue.stripeAccountId });
      }

      // Crea Connected Account Express
      const account = await stripe.accounts.create({
        type: 'express',
        country: country ?? 'IT',
        ...(email ? { email } : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: resolvedBusinessType,
        business_profile: {
          name: venue.name,
          mcc: '5813', // Night clubs / bars
        },
      });

      // Genera Account Link per onboarding
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: `${cfg.BASE_URL}/`,
        return_url: `${cfg.BASE_URL}/`,
        type: 'account_onboarding',
      });

      // Salva stripeAccountId
      await prisma.venue.update({
        where: { id: venueId },
        data: { stripeAccountId: account.id },
      });

      req.log.info(
        { venueId, stripeAccountId: account.id },
        'Onboarding Stripe Connect avviato'
      );

      return {
        accountId: account.id,
        onboardingUrl: accountLink.url,
        expiresAt: accountLink.expires_at,
      };
    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // [FIX 3.5] Lista venue con stato onboarding
  fastify.get('/api/admin/venues', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminAuth(req, cfg.ADMIN_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const venues = await prisma.venue.findMany({
        select: {
          id: true,
          name: true,
          stripeAccountId: true,
          applicationFeePercent: true,
          stripeChargesEnabled: true,
          stripePayoutsEnabled: true,
          stripeOnboardedAt: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { venues };
    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // [FIX 3.5] Genera nuovo Account Link per onboarding incompleto (Admin panel)
  fastify.post('/api/admin/venues/:id/refresh-link', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminAuth(req, cfg.ADMIN_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const { id } = req.params as { id: string };
      const venue = await prisma.venue.findUnique({ where: { id } });

      if (!venue) {
        return reply.status(404).send({ error: 'Venue non trovato' });
      }

      if (!venue.stripeAccountId) {
        return reply.status(400).send({ error: 'Venue non ancora onboardato' });
      }
      const accountLink = await stripe.accountLinks.create({
        account: venue.stripeAccountId,
        refresh_url: `${cfg.BASE_URL}/`,
        return_url: `${cfg.BASE_URL}/`,
        type: 'account_onboarding',
      });

      return { onboardingUrl: accountLink.url, expiresAt: accountLink.expires_at };
    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // [FIX 3.5] Callback dopo onboarding completato (return_url admin)
  fastify.get('/api/admin/venues/:id/onboarded', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdminAuth(req, cfg.ADMIN_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const { id } = req.params as { id: string };
      const venue = await prisma.venue.findUnique({ where: { id } });

      if (!venue || !venue.stripeAccountId) {
        return reply.status(404).send({ error: 'Venue o account non trovato' });
      }

      // Recupera status aggiornato da Stripe
      const account = await stripe.accounts.retrieve(venue.stripeAccountId);

      const isOnboarded = account.charges_enabled && account.payouts_enabled;
      await prisma.venue.update({
        where: { id },
        data: {
          stripeChargesEnabled: account.charges_enabled,
          stripePayoutsEnabled: account.payouts_enabled,
          stripeOnboardedAt: isOnboarded ? new Date() : null,
        },
      });

      return {
        success: true,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        fullyOnboarded: isOnboarded,
      };
    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });
}

// Retrocompat
export async function adminRoutes(fastify: FastifyInstance) {
  const cfg = globalConfig;
  return registerAdminRoutes(fastify, {
    prisma: globalPrisma,
    config: cfg,
    stripe: new Stripe(cfg.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    }),
  });
}
