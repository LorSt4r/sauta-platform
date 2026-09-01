import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { prisma as globalPrisma } from '../utils/prisma';
import { signToken, verifyToken } from '../utils/jwt';
import { escapeHtml } from '../utils/html';
import {
  config as globalConfig,
  type AppConfig,
} from '../utils/config';
import {
  voidAcubeReceipt as defaultVoidAcubeReceipt,
  getAcubeToken as defaultGetAcubeToken,
} from '../utils/acubeClient';
import {
  ensureSessionInvoiced as defaultEnsureSessionInvoiced,
} from '../utils/fiscalReconciler';
import { safeSecretEqual } from '../utils/secrets';
import {
  generateWalletToken,
  hashWalletToken,
  isValidTokenFormat,
  verifyWalletCapability,
} from '../utils/capability';

const MAX_WALLET_ITEMS = 20;
const MAX_WALLET_TICKETS_PER_SESSION = 100;
const MAX_WALLET_RESPONSE_BYTES = 512 * 1024;

interface WalletQueryItem {
  sessionId: string;
  token: string;
}

const walletCredentialSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'token'],
  properties: {
    sessionId: { type: 'string', minLength: 1, maxLength: 128 },
    token: { type: 'string', pattern: '^swc_[a-f0-9]{64}$' },
  },
} as const;

export interface StripeFiscalServices {
  voidAcubeReceipt: typeof defaultVoidAcubeReceipt;
  getAcubeToken: typeof defaultGetAcubeToken;
  ensureSessionInvoiced: typeof defaultEnsureSessionInvoiced;
}

export interface StripeRouteDeps {
  prisma: PrismaClient;
  stripe: Stripe;
  config: AppConfig;
  fiscalServices: StripeFiscalServices;
}

/**
 * Factory testabile: registra le route Stripe con deps iniettate.
 */
export async function registerStripeRoutes(
  fastify: FastifyInstance,
  deps: StripeRouteDeps
) {
  const { prisma, stripe, config: cfg, fiscalServices } = deps;
  // 0.1 Endpoint per servire dinamicamente la chiave pubblica Stripe
  fastify.get('/api/config', async () => {
    return {
      stripePublishableKey: cfg.STRIPE_PUBLISHABLE_KEY
    };
  });

  // GET /api/venue/current — restituisce info pubbliche minime sulla venue corrente (risolta da hostname)
  fastify.get('/api/venue/current', {
    preHandler: fastify.tenantGuard ? [fastify.tenantGuard] : [],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.status(404).send({ error: 'Not Found' });
    }
    return {
      venue: {
        name: req.tenant.venueName,
        hostname: req.tenant.hostname,
      },
    };
  });

  // GET /api/venue/current/menu — restituisce i prodotti attivi della venue corrente
  fastify.get('/api/venue/current/menu', {
    preHandler: fastify.tenantGuard ? [fastify.tenantGuard] : [],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenant) {
      return reply.status(404).send({ error: 'Not Found' });
    }
    const products = await prisma.product.findMany({
      where: { venueId: req.tenant.venueId, active: true },
      select: { id: true, slug: true, name: true, price: true },
    });
    return { products };
  });

  // 1. Endpoint chiamato dall'app (PWA) quando l'utente preme "Paga"
  fastify.post('/api/checkout', {
    preHandler: fastify.tenantGuard ? [fastify.tenantGuard] : [],
    schema: {
      body: {
        type: 'object',
        required: ['totalAmount', 'items', 'digitalConsent'],
        additionalProperties: false,
        properties: {
          totalAmount: { type: 'number' },
          items: { type: 'object', additionalProperties: { type: 'integer' } },
          digitalConsent: { type: 'boolean' }
        }
      }
    }
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!req.tenant) {
        return reply.status(404).send({ error: 'Not Found' });
      }
      const venueId = req.tenant.venueId;

      // [Wave 4] Privacy by Design: non raccogliamo email — clienti anonimi
      const { totalAmount, items, digitalConsent } = req.body as {
        totalAmount: number,
        items: Record<string, number>,
        digitalConsent?: boolean
      };

      // [FIX 1.11] Validazione consenso digitale server-side
      if (digitalConsent !== true) {
        return reply.status(400).send({
          error: 'Consenso allo scontrino digitale obbligatorio per completare l\'ordine (D.M. 07/12/2016)'
        });
      }

      // [FIX 1.14] La venue deve già esistere nel DB e essere attiva
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        include: { products: { where: { active: true } } }
      });
      if (!venue || !venue.isActive) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      // Mappa prodotti dal DB
      const dbProducts = Object.fromEntries(venue.products.map(p => [p.slug, p]));

      // 1. Validazione backend e ricalcolo totale (sicurezza)
      let computedTotal = 0;
      const validItems: { slug: string, name: string, price: number, qty: number, vatRate: number }[] = [];
      const MAX_ITEM_QTY = 99;
      const MAX_TOTAL_QTY = 99;
      let totalQty = 0;

      if (items) {
        for (const [slug, qty] of Object.entries(items)) {
          if (!Number.isInteger(qty) || qty <= 0) continue;
          if (qty > MAX_ITEM_QTY) {
            return reply.status(400).send({ error: `Quantità massima per singolo prodotto superata (max ${MAX_ITEM_QTY})` });
          }
          totalQty += qty;
          const product = dbProducts[slug];
          if (product) {
            computedTotal += product.price * qty;
            validItems.push({ slug, name: product.name, price: product.price, qty, vatRate: product.vatRate ?? 10.0 });
          }
        }
      }

      if (totalQty > MAX_TOTAL_QTY) {
        return reply.status(400).send({ error: `Quantità totale nel carrello superata (max ${MAX_TOTAL_QTY} articoli)` });
      }

      // [FIX 1.13 parziale] Se il totale calcolato è 0 ma ci sono items, errore
      if (computedTotal === 0) {
        return reply.status(400).send({ error: 'Nessun prodotto valido nel carrello' });
      }

      // 2. Salvare la "CheckoutSession" e i "Ticket" nel database in stato 'pending'
      // [FIX 2.5] priceSnapshot: immutabilizza il prezzo al momento acquisto
      // [FIX 2.4] vatRate per-prodotto salvato sul ticket
      // [Wave 4] Privacy by Design: salviamo solo consentTimestamp, nessun dato personale
      const walletToken = generateWalletToken();
      const session = await prisma.checkoutSession.create({
        data: {
          venueId: venueId,
          totalAmount: computedTotal,
          digitalConsent: true,
          digitalConsentTimestamp: new Date(), // [Wave 4] audit trail GDPR D.M. 07/12/2016
          tickets: {
            create: validItems.flatMap(item =>
              Array(item.qty).fill({
                venueId: venueId,
                productName: item.name,
                price: item.price,
                priceSnapshot: item.price, // [FIX 2.5] snapshot immutable
                vatRate: item.vatRate, // [FIX 2.4] IVA per-prodotto
                status: 'pending'
              })
            ),
          },
          walletCapability: {
            create: {
              tokenHash: hashWalletToken(walletToken),
            },
          },
        }
      });

      // Crea il PaymentIntent per Apple Pay / Carte
      // [FIX 3.2] Se venue ha stripeAccountId, usa Connect con transfer_data
      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: computedTotal, // in centesimi (es. 1000 = €10.00)
        currency: 'eur',
        automatic_payment_methods: { enabled: true }, // Fondamentale per Apple/Google Pay
        // [Wave 4] Nessuna receipt_email — Privacy by Design, clienti anonimi
        metadata: { venueId, sessionId: session.id },
      };

      // [FIX 3.2] Stripe Connect: se venue ha account Stripe valido, redirige il pagamento
      if (venue.stripeAccountId) {
        const { validateStripeAccountId } = await import('../utils/stripeAccount.js');
        if (validateStripeAccountId(venue.stripeAccountId)) {
          paymentIntentParams.transfer_data = { destination: venue.stripeAccountId };
          // Calcola application fee: venue.applicationFeePercent (default 2.9%)
          const feePercent = venue.applicationFeePercent ?? 2.9;
          paymentIntentParams.application_fee_amount = Math.round(
            (computedTotal * feePercent) / 100
          );
          req.log.info(
            {
              venueId,
              feePercent,
              applicationFeeAmount: paymentIntentParams.application_fee_amount,
            },
            'PaymentIntent Connect configurato'
          );
        } else {
          req.log.warn(
            { venueId },
            'Connected account non valido: uso del flusso legacy piattaforma'
          );
        }
      }

      const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

      return { clientSecret: paymentIntent.client_secret, sessionId: session.id, walletToken };
    } catch (error: any) {
      req.log.error(error);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // 2. Webhook sicuro di Stripe per confermare il pagamento
  fastify.post('/api/webhook/stripe', {
    config: { rawBody: true } // Richiede fastify-raw-body per il body grezzo
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = req.headers['stripe-signature'] as string;
    let event: any = null;

    try {
      // [FIX 1.1] Verifica rigorosa della firma del webhook — usa il raw body
      const rawBody = (req as any).rawBody || req.body;
      const secrets = cfg.STRIPE_WEBHOOK_SECRET.split(',');
      let lastErr: any = null;

      for (const secret of secrets) {
        try {
          event = stripe.webhooks.constructEvent(
            rawBody,
            sig,
            secret.trim()
          );
          if (event) break;
        } catch (err: any) {
          lastErr = err;
        }
      }

      if (!event) {
        throw lastErr || new Error('No webhook secrets matched the signature');
      }
    } catch (err: any) {
      // [FIX 1.1] In caso di firma invalida, RIFIUTA con 400. Nessun fallback.
      req.log.warn({ err }, 'Firma webhook Stripe non valida');
      return reply.status(400).send({ error: 'Webhook signature verification failed' });
    }

    // Gestione del completamento
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const sessionId = paymentIntent.metadata?.sessionId;
      const venueId = paymentIntent.metadata?.venueId;

      req.log.info(
        { sessionId, amount: paymentIntent.amount },
        'Pagamento Stripe completato'
      );

      if (sessionId) {
        try {
          // [FIX 1.8 + 0.7 + Dedup] Transazione atomica con guard status === 'pending' e deduplicazione event.id
          const result = await prisma.$transaction(async (tx) => {
            // Deduplicazione atomica su event.id: se l'evento è già presente nel DB, rollback/skip
            if (event.id) {
              try {
                await tx.processedWebhookEvent.create({
                  data: { id: event.id, eventType: event.type }
                });
              } catch (dedupErr: any) {
                if (dedupErr.code === 'P2002') {
                  req.log.info({ eventId: event.id }, 'Webhook già processato');
                  return { isDuplicate: true };
                }
                throw dedupErr;
              }
            }

            const updated = await tx.checkoutSession.updateMany({
              where: { id: sessionId, status: 'pending' },
              data: { status: 'paid', stripePaymentIntentId: paymentIntent.id }
            });

            if (updated.count === 0) {
              const session = await tx.checkoutSession.findUnique({
                where: { id: sessionId },
                include: { venue: true }
              });
              return { skipped: true, session, alreadyPaid: session?.status === 'paid' };
            }

            const updatedSession = await tx.checkoutSession.findUnique({
              where: { id: sessionId },
              include: { venue: true }
            });

            await tx.ticket.updateMany({
              where: { sessionId: sessionId },
              data: { status: 'valid' }
            });

            return { skipped: false, alreadyPaid: false, session: updatedSession! };
          });

          if ((result as any).isDuplicate) {
            return reply.status(200).send({ received: true, deduplicated: true });
          }

          if (result.alreadyPaid || result.skipped) {
            req.log.info(
              { sessionId, status: result.session?.status },
              'Webhook ignorato per stato sessione'
            );
            // [FIX A] Se già pagata ma non fatturata (crash/errore A-Cube precedente),
            // il retry di Stripe deve chiudere la finestra: riprova la fatturazione ora.
            if (result.session?.status === 'paid' && result.session.fiscalStatus !== 'invoiced') {
              await fiscalServices.ensureSessionInvoiced({
                prisma,
                isProduction: cfg.IS_PRODUCTION,
                logger: req.log,
              }, sessionId);
            }
            return reply.status(200).send({ received: true });
          }

          // [Wave 4] Privacy by Design: nessuna email inviata al cliente

          // Generate commercial receipt via A-Cube cloud API
          // [FIX A] Non-throwing: errore A-Cube → invoicing_failed + 200;
          // i retry sono gestiti dal reconciler e dai webhook successivi.
          if (venueId && result.session?.venue) {
            await fiscalServices.ensureSessionInvoiced({
              prisma,
              isProduction: cfg.IS_PRODUCTION,
              logger: req.log,
            }, sessionId);
          }
        } catch (dbErr) {
          // [FIX 0.6] Rispondi 5xx per forzare retry di Stripe.
          // Rispondere 200 faceva perdere la sessione per sempre (pagato ma non certificato).
          req.log.error(
            { err: dbErr },
            'Errore DB durante processamento pagamento'
          );
          return reply.status(500).send({ error: 'DB error processing webhook' });
        }
      }
    }

    // [FIX 3.4 + Dedup] Webhook account.updated: aggiorna stato onboarding venue con deduplicazione atomica
    if (event.type === 'account.updated') {
      const account = event.data.object as Stripe.Account;
      const isOnboarded = account.charges_enabled && account.payouts_enabled;

      try {
        await prisma.$transaction(async (tx) => {
          if (event.id) {
            try {
              await tx.processedWebhookEvent.create({
                data: { id: event.id, eventType: event.type }
              });
            } catch (dedupErr: any) {
              if (dedupErr.code === 'P2002') {
                req.log.info(
                  { eventId: event.id },
                  'Webhook account.updated già processato'
                );
                return;
              }
              throw dedupErr;
            }
          }

          const venue = await tx.venue.findFirst({
            where: { stripeAccountId: account.id },
          });

          if (venue) {
            await tx.venue.update({
              where: { id: venue.id },
              data: {
                stripeChargesEnabled: account.charges_enabled,
                stripePayoutsEnabled: account.payouts_enabled,
                stripeOnboardedAt: isOnboarded ? new Date() : null,
              },
            });
            req.log.info(
              {
                venueId: venue.id,
                chargesEnabled: account.charges_enabled,
                payoutsEnabled: account.payouts_enabled,
              },
              'Connected account aggiornato'
            );
          } else {
            req.log.warn(
              { stripeAccountId: account.id },
              'Webhook account.updated senza venue associata'
            );
          }
        });
      } catch (err: any) {
        req.log.error({ err }, 'Errore DB durante account.updated');
        return reply.status(500).send({ error: 'DB error processing account.updated webhook' });
      }
    }

    return reply.status(200).send({ received: true });
  });

  // 2.5 Endpoint sincrono di conferma (in aggiunta al webhook, per affidabilità immediata)
  fastify.post('/api/checkout/confirm', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { paymentIntentId } = req.body as { paymentIntentId: string };
      if (!paymentIntentId) return reply.status(400).send({ error: 'paymentIntentId mancante' });

      // [FIX 1.4] Il mock bypass è consentito solo in sviluppo
      if (paymentIntentId.startsWith('mock_')) {
        if (cfg.IS_PRODUCTION) {
          return reply.status(400).send({ error: 'Mock non consentito in produzione' });
        }
      }

      let sessionId: string;
      let venueId: string | undefined;
      let stripeIntentId = paymentIntentId;

      if (paymentIntentId.startsWith('mock_')) {
        sessionId = paymentIntentId.replace('mock_', '');
        const session = await prisma.checkoutSession.findUnique({
          where: { id: sessionId }
        });
        if (!session) return reply.status(404).send({ error: 'Sessione non trovata' });
        venueId = session.venueId;
      } else {
        // Recupera lo stato reale da Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
          return reply.status(400).send({ error: 'Il pagamento non è andato a buon fine su Stripe' });
        }

        sessionId = paymentIntent.metadata?.sessionId || '';
        venueId = paymentIntent.metadata?.venueId;

        if (!sessionId) {
          return reply.status(400).send({ error: 'Nessuna sessione trovata nei metadati' });
        }
      }

      // [FIX 1.8] Transazione atomica con guard idempotenza
      const result = await prisma.$transaction(async (tx) => {
        const session = await tx.checkoutSession.findUnique({
          where: { id: sessionId },
          include: { venue: true }
        });

        if (!session) throw new Error('Sessione non trovata');

        const updated = await tx.checkoutSession.updateMany({
          where: { id: sessionId, status: 'pending' },
          data: { status: 'paid', stripePaymentIntentId: stripeIntentId }
        });

        if (updated.count === 0) {
          const freshSession = await tx.checkoutSession.findUnique({
            where: { id: sessionId },
            include: { venue: true }
          });
          return { alreadyPaid: true, session: freshSession! };
        }

        const updatedSession = await tx.checkoutSession.findUnique({
          where: { id: sessionId },
          include: { venue: true }
        });

        await tx.ticket.updateMany({
          where: { sessionId: sessionId },
          data: { status: 'valid' }
        });

        return { alreadyPaid: false, session: updatedSession! };
      });

      const tickets = await prisma.ticket.findMany({
        where: { sessionId },
        select: {
          id: true,
          productName: true,
          price: true,
          status: true,
          usedAt: true,
          createdAt: true,
        },
      });

      // [Wave 4] Privacy by Design: nessuna email inviata al cliente

      // Generate commercial receipt via A-Cube cloud API only if not already processed
      // [FIX A] ensureSessionInvoiced è idempotente: copre sia il path fresco sia
      // il caso alreadyPaid-non-fatturata (finestra di perdita scontrino chiusa).
      if (result.session?.venue) {
        await fiscalServices.ensureSessionInvoiced({
          prisma,
          isProduction: cfg.IS_PRODUCTION,
          logger: req.log,
        }, sessionId);
      }

      return { success: true, tickets };

    } catch (err: any) {
      req.log.error({ err }, 'Errore API confirm');
      reply.status(500).send({ error: 'Errore durante la conferma del pagamento' });
    }
  });

  // 3. POST /api/wallet/query: Query autorizzata per il wallet anonimo via capability
  fastify.post('/api/wallet/query', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_WALLET_ITEMS,
            items: walletCredentialSchema,
          },
        },
      },
    },
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { items } = req.body as { items: WalletQueryItem[] };
      if (!items.every((item) => isValidTokenFormat(item.token))) {
        return reply.status(400).send({ error: 'Formato capability non valido' });
      }

      const requestedPairs = items.map((item) => ({
        sessionId: item.sessionId,
        tokenHash: hashWalletToken(item.token),
      }));
      const capabilities = await prisma.walletCapability.findMany({
        where: {
          revokedAt: null,
          OR: requestedPairs,
        },
        select: {
          sessionId: true,
          tokenHash: true,
        },
      });
      const authorizedPairs = new Set(
        capabilities.map(({ sessionId, tokenHash }) => `${sessionId}:${tokenHash}`)
      );
      const authorizedSessionIds = [
        ...new Set(
          requestedPairs
            .filter(({ sessionId, tokenHash }) =>
              authorizedPairs.has(`${sessionId}:${tokenHash}`)
            )
            .map(({ sessionId }) => sessionId)
        ),
      ];

      const sessions = authorizedSessionIds.length === 0
        ? []
        : await prisma.checkoutSession.findMany({
          where: {
            id: { in: authorizedSessionIds },
            status: 'paid',
          },
          select: {
            id: true,
            totalAmount: true,
            currency: true,
            status: true,
            fiscalStatus: true,
            digitalConsent: true,
            createdAt: true,
            venue: {
              select: {
                id: true,
                name: true,
                vatNumber: true,
                fiscalAddress: true,
                fiscalCity: true,
                fiscalZip: true,
              },
            },
            tickets: {
              select: {
                id: true,
                productName: true,
                price: true,
                status: true,
                usedAt: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
              take: MAX_WALLET_TICKETS_PER_SESSION,
            },
          },
        });
      const sessionsById = new Map(sessions.map((session) => [session.id, session]));
      const response = {
        sessions: authorizedSessionIds.flatMap((sessionId) => {
          const session = sessionsById.get(sessionId);
          if (!session) return [];
          return [{
            session: {
              id: session.id,
              totalAmount: session.totalAmount,
              currency: session.currency,
              status: session.status,
              fiscalStatus: session.fiscalStatus,
              digitalConsent: session.digitalConsent,
              createdAt: session.createdAt,
            },
            venue: session.venue,
            tickets: session.tickets,
          }];
        }),
      };

      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_WALLET_RESPONSE_BYTES) {
        return reply.status(413).send({ error: 'Risposta wallet troppo grande' });
      }

      return response;
    } catch (err: any) {
      req.log.error({ err }, 'Errore query wallet');
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // 3.5 POST /api/wallet/consume-token: Genera consumeToken JWT monouso a breve scadenza per lo Swipe
  fastify.post('/api/wallet/consume-token', {
    schema: {
      body: {
        ...walletCredentialSchema,
        required: ['sessionId', 'token', 'ticketId'],
        properties: {
          ...walletCredentialSchema.properties,
          ticketId: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId, token, ticketId } = req.body as {
        sessionId: string;
        token: string;
        ticketId: string;
      };

      if (!sessionId || !token || !ticketId) {
        return reply.status(400).send({ error: 'Parametri mancanti' });
      }

      const isAuthorized = await verifyWalletCapability(prisma, sessionId, token);
      if (!isAuthorized) {
        return reply.status(401).send({ error: 'Capability non valida o revocata' });
      }

      const ticket = await prisma.ticket.findFirst({
        where: {
          id: ticketId,
          sessionId,
        },
        select: {
          id: true,
          venueId: true,
          status: true,
        },
      });
      if (!ticket) {
        return reply.status(404).send({ error: 'Ticket non trovato per questa sessione' });
      }

      if (ticket.status !== 'valid') {
        return reply.status(409).send({ error: 'Ticket già consumato o non valido' });
      }

      const consumeToken = signToken(
        { ticketId: ticket.id, venueId: ticket.venueId },
        cfg.TICKET_JWT_SECRET,
        { expiresIn: '5m', audience: 'consume', subject: ticket.id }
      );

      return { consumeToken };
    } catch (err: any) {
      req.log.error({ err }, 'Errore generazione consumeToken');
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // 4. POST /api/consume: Consumo atomico del ticket via Swipe to Consume
  fastify.post('/api/consume', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['consumeToken'],
        properties: {
          consumeToken: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { consumeToken } = req.body as { consumeToken: string };
      const decoded = verifyToken(consumeToken, cfg.TICKET_JWT_SECRET, {
        audience: 'consume',
      });
      if (!decoded || decoded.sub !== decoded.ticketId) {
        return reply.status(401).send({ error: 'Firma token non valida o token scaduto' });
      }

      // Aggiornamento atomico dello stato da valid a used
      const updated = await prisma.ticket.updateMany({
        where: {
          id: decoded.ticketId,
          venueId: decoded.venueId,
          status: 'valid',
        },
        data: {
          status: 'used',
          usedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        return reply.status(409).send({ error: 'Ticket già consumato o non valido' });
      }

      return { success: true, message: 'Ticket consumato con successo', ticketId: decoded.ticketId };
    } catch (err: any) {
      req.log.error({ err }, 'Errore API consume');
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // 5. Generatore di Seed Giornaliero per Animazione Anti-Frode
  fastify.get('/api/daily-seed', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Calcoliamo un hash deterministico del giorno + segreto
      let hash = 0;
      const combined = todayStr + cfg.JWT_SECRET;
      for (let i = 0; i < combined.length; i++) {
        hash = (hash << 5) - hash + combined.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
      }

      return { seed: Math.abs(hash), date: todayStr };
    } catch (err: any) {
      req.log.error({ err }, 'Errore API seed');
      reply.status(500).send({ error: 'Failed to generate seed' });
    }
  });

  // 5.5 [FIX 2.3] Endpoint annullamento/storno sessione fiscale
  fastify.post('/api/session/void', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId, reason, voidedById, venueId } = req.body as {
        sessionId: string;
        reason: string;
        voidedById: string;
        venueId: string;
      };

      // [FIX 2.6] Validazione input con funzione pura
      const {
        validateVoidRequest,
        determineVoidType,
        validateFiscalTransition,
        voidTypeToOperationKind,
      } = await import('../utils/fiscal.js');
      const validation = validateVoidRequest({ sessionId, reason: reason as any, voidedById });
      if (!validation.valid) {
        return reply.status(400).send({ error: validation.error });
      }

      if (!venueId) {
        return reply.status(400).send({ error: 'venueId mancante' });
      }

      // [FIX 2.6] Auth venue — verificare che il chiamante sia autorizzato per questa venue.
      // Consentiamo l'accesso se viene fornito un X-Admin-Secret valido (Global Admin)
      const adminSecret = req.headers['x-admin-secret'];
      let authorized = false;

      // [FIX B] confronto timing-safe anche per gli annulli fiscali
      if (safeSecretEqual(Array.isArray(adminSecret) ? adminSecret[0] : adminSecret, cfg.ADMIN_SECRET)) {
        authorized = true;
      }

      if (!authorized) {
        return reply.status(401).send({ error: 'Non autorizzato: credenziali non valide per questa venue' });
      }

      // Trova la sessione
      const session = await prisma.checkoutSession.findUnique({
        where: { id: sessionId },
        include: { tickets: true, venue: true },
      });

      if (!session) {
        return reply.status(404).send({ error: 'Sessione non trovata' });
      }

      if (session.venueId !== venueId) {
        return reply.status(403).send({ error: 'Sessione non appartiene al venue' });
      }

      // Determina tipo void (same-day → voided, giorno dopo → storno)
      const voidType = determineVoidType(session.createdAt);
      const currentFiscalStatus = session.fiscalStatus as 'pending' | 'invoiced' | 'voided' | 'storno';

      // Valida transizione fiscale
      try {
        validateFiscalTransition(currentFiscalStatus, voidType);
      } catch (transitionErr: any) {
        return reply.status(409).send({ error: transitionErr.message });
      }

      // Transazione atomica: aggiorna sessione + ticket + FiscalLog con retry per collisioni di sequenza
      const {
        computeFiscalHash,
        GENESIS_HASH,
        getLastFiscalEntry,
        withFiscalRetry,
      } = await import('../utils/fiscalLogHelper.js');
      const result = await withFiscalRetry(prisma, async (tx) => {
        // Aggiorna sessione
        const updated = await tx.checkoutSession.update({
          where: { id: sessionId },
          data: {
            fiscalStatus: voidType,
            voidedAt: new Date(),
            voidedReason: reason,
            voidedById,
          },
        });

        // Aggiorna ticket a 'voided'
        await tx.ticket.updateMany({
          where: { sessionId },
          data: { status: 'voided', voidedAt: new Date(), voidedReason: reason },
        });

        // Crea FiscalLog per l'annullamento/storno
        const operationKind = voidTypeToOperationKind(voidType);
        const { sequenceNumber, hash: previousHash } = await getLastFiscalEntry(tx, venueId);
        const fiscalTimestamp = new Date().toISOString();
        const signSecret = cfg.JWT_SECRET;
        const fiscalHash = computeFiscalHash({
          sequenceNumber,
          previousHash,
          sessionId,
          timestamp: fiscalTimestamp,
          printerBrand: 'void',
          commandPayload: JSON.stringify({ reason, voidedById }),
          statusResponse: voidType,
          success: true,
          errorMessage: null,
        }, signSecret);

        const fiscalLog = await tx.fiscalLog.create({
          data: {
            sessionId,
            printerBrand: 'void',
            commandPayload: JSON.stringify({ reason, voidedById }),
            statusResponse: voidType,
            success: true,
            sequenceNumber,
            previousHash,
            hash: fiscalHash,
            venueId,
            operationKind,
            correlativeId: session.id, // correla alla sessione originale
            timestamp: new Date(fiscalTimestamp),
          },
        });

        return { session: updated, voidType, fiscalLog };
      });

      if (session.fiscalDocNumber || session.fiscalReceiptUrl) {
        const voidTarget = session.fiscalDocNumber || session.fiscalReceiptUrl;
        await fiscalServices.voidAcubeReceipt(
          session.venue,
          voidTarget!,
          reason,
          { isProduction: cfg.IS_PRODUCTION }
        );
      }

      req.log.info(
        { sessionId, voidType: result.voidType, reason },
        'Operazione fiscale void/storno registrata'
      );

      return {
        success: true,
        voidType: result.voidType,
        sessionId,
        fiscalLogId: result.fiscalLog.id,
      };
    } catch (err: any) {
      req.log.error({ err }, 'Errore API void');
      reply.status(500).send({ error: 'Errore durante annullamento' });
    }
  });

  // 6. Endpoint POST /api/wallet/receipt: Consultazione ricevuta HTML autorizzata da capability e consenso
  fastify.post('/api/wallet/receipt', {
    schema: {
      body: walletCredentialSchema,
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId, token } = req.body as { sessionId: string; token: string };

      if (!sessionId || !token) {
        return reply.status(400).send({ error: 'Parametri sessionId e token obbligatori' });
      }

      const isAuthorized = await verifyWalletCapability(prisma, sessionId, token);
      if (!isAuthorized) {
        return reply.status(401).send({ error: 'Non autorizzato: capability del wallet non valida' });
      }

      const session = await prisma.checkoutSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          totalAmount: true,
          digitalConsent: true,
          digitalConsentTimestamp: true,
          createdAt: true,
          venue: {
            select: {
              name: true,
            },
          },
          tickets: {
            select: {
              productName: true,
              price: true,
            },
          },
        },
      });

      if (!session) {
        return reply.status(404).send({ error: 'Sessione non trovata' });
      }

      if (!session.digitalConsent || !session.digitalConsentTimestamp) {
        return reply.status(403).send({ error: 'Consenso digitale non fornito per questa transazione' });
      }

      // Raccogliamo i drink acquistati e le relative quantità
      const drinkCounts: Record<string, { qty: number; price: number; name: string }> = {};
      const DRINK_MAP_NAMES: Record<string, string> = {
        'vodka-redbull': 'Vodka Redbull',
        'gin-tonic': 'Gin Tonic',
        'negroni': 'Negroni',
        'aperol-spritz': 'Aperol Spritz',
        'mojito': 'Mojito',
        'moscow-mule': 'Moscow Mule',
        'cuba-libre': 'Cuba Libre'
      };

      session.tickets.forEach(ticket => {
        let entry = drinkCounts[ticket.productName];
        if (!entry) {
          entry = {
            qty: 0,
            price: ticket.price,
            name: DRINK_MAP_NAMES[ticket.productName] || ticket.productName
          };
          drinkCounts[ticket.productName] = entry;
        }
        entry.qty += 1;
      });

      const receiptDate = new Date(session.createdAt);
      const formattedDate = receiptDate.toLocaleDateString('it-IT');
      const formattedTime = receiptDate.toLocaleTimeString('it-IT');
      const totalEur = (session.totalAmount / 100).toFixed(2);
      const totalIva = (session.totalAmount / 100 * 0.1).toFixed(2); // IVA 10% inclusa per somministrazione
      const imponibile = (session.totalAmount / 100 / 1.1).toFixed(2);

      // Generiamo un codice di trasmissione AdE fittizio ed un numero progressivo RT basato sull'id
      // NOTA: In produzione questi dati dovranno provenire dalla risposta dell'RT (Fase 3)
      const rtProg = session.id.slice(0, 4).toUpperCase() + '-' + session.id.slice(4, 8).toUpperCase();
      const adeCode = '99RT' + session.id.replace(/-/g, '').slice(0, 16).toUpperCase();

      // [FIX 1.12] Tutti i valori interpolati nell'HTML sono sanitizzati contro XSS
      const safeVenueName = escapeHtml(session.venue.name);

      // Restituisce l'HTML che simula lo scontrino cartaceo
      return reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Documento Commerciale - Sauta</title>
          <style>
            body {
              background-color: #f3f4f6;
              font-family: 'Courier New', Courier, monospace;
              padding: 20px;
              margin: 0;
              display: flex;
              justify-content: center;
              color: #000;
            }
            .receipt {
              background: #fff;
              width: 320px;
              padding: 25px 20px;
              box-shadow: 0 4px 15px rgba(0,0,0,0.1);
              border-radius: 4px;
              box-sizing: border-box;
            }
            .center {
              text-align: center;
            }
            .title {
              font-weight: bold;
              font-size: 1.2rem;
              margin-bottom: 2px;
            }
            .divider {
              border-top: 1px dashed #000;
              margin: 15px 0;
            }
            .row {
              display: flex;
              justify-content: space-between;
              font-size: 0.95rem;
              margin-bottom: 5px;
            }
            .row-bold {
              font-weight: bold;
              font-size: 1.05rem;
            }
            .footer-info {
              font-size: 0.8rem;
              margin-top: 15px;
              line-height: 1.3;
            }
            .draft-notice {
              background: #fef3cd;
              border: 1px solid #ffc107;
              color: #856404;
              padding: 8px;
              font-size: 0.75rem;
              text-align: center;
              margin-bottom: 15px;
              border-radius: 4px;
            }
            .btn-print {
              display: block;
              width: 100%;
              text-align: center;
              background: #000;
              color: #fff;
              padding: 10px;
              margin-top: 20px;
              border: none;
              font-family: inherit;
              font-weight: bold;
              cursor: pointer;
              border-radius: 4px;
              text-transform: uppercase;
            }
            @media print {
              body { background: none; padding: 0; }
              .receipt { box-shadow: none; width: 100%; padding: 0; }
              .btn-print { display: none; }
            }
          </style>
        </head>
        <body>
          <div class="receipt">
            <div class="draft-notice">
              ⚠️ PRE-SCONTRINO DI CORTESIA — NON HA VALENZA FISCALE<br>
              Il documento commerciale ufficiale è emesso dal Registratore Telematico del locale.
            </div>
            <div class="center">
              <div class="title">${safeVenueName.toUpperCase()}</div>
            </div>

            <div class="divider"></div>

            <div class="center" style="font-weight: bold; margin-bottom: 10px;">
              RIEPILOGO ORDINE DIGITALE<br>Sauta - Salta la Fila
            </div>

            <div class="divider"></div>

            ${Object.values(drinkCounts).map(item => `
              <div class="row">
                <span>${item.qty}x ${escapeHtml(item.name)}</span>
                <span>€${(item.price * item.qty / 100).toFixed(2)}</span>
              </div>
              <div class="row" style="font-size: 0.8rem; color: #555; margin-bottom: 8px;">
                <span>Prezzo unitario: €${(item.price / 100).toFixed(2)} (IVA 10%)</span>
              </div>
            `).join('')}

            <div class="divider"></div>

            <div class="row row-bold">
              <span>TOTALE COMPLESSIVO</span>
              <span>€${totalEur}</span>
            </div>
            <div class="row">
              <span>Di cui IVA 10%</span>
              <span>€${totalIva}</span>
            </div>
            <div class="row">
              <span>Imponibile</span>
              <span>€${imponibile}</span>
            </div>
            <div class="row" style="margin-top: 10px;">
              <span>PAGAMENTO ELETTRONICO</span>
              <span>€${totalEur}</span>
            </div>

            <div class="divider"></div>

            <div class="footer-info">
              <div class="row">
                <span>DATA: ${formattedDate}</span>
                <span>ORA: ${formattedTime}</span>
              </div>
              <div class="row">
                <span>RIF. ORDINE:</span>
                <span>${escapeHtml(rtProg)}</span>
              </div>
              <div class="center" style="margin-top: 15px; font-size: 0.75rem;">
                Grazie per aver acquistato con Sauta!<br>
                Riepilogo digitale di cortesia (non fiscale)
              </div>
            </div>

            <p class="center footer-info">Usa il comando di stampa del browser per stampare il riepilogo.</p>
          </div>
        </body>
        </html>
      `);
    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // 7. Proxy endpoint POST /api/wallet/receipt/pdf: Download PDF A-Cube autorizzato da capability e consenso
  fastify.post('/api/wallet/receipt/pdf', {
    schema: {
      body: walletCredentialSchema,
    },
    helmet: {
      contentSecurityPolicy: false,
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId, token: reqToken } = req.body as { sessionId: string; token: string };

      if (!sessionId || !reqToken) {
        return reply.status(400).send({ error: 'Parametri sessionId e token obbligatori' });
      }

      const isAuthorized = await verifyWalletCapability(prisma, sessionId, reqToken);
      if (!isAuthorized) {
        return reply.status(401).send({ error: 'Non autorizzato: capability del wallet non valida' });
      }

      const session = await prisma.checkoutSession.findUnique({
        where: { id: sessionId },
        select: {
          fiscalDocNumber: true,
          fiscalReceiptUrl: true,
          digitalConsent: true,
          venue: {
            select: {
              acubeApiKey: true,
              acubeOrganizationId: true,
            },
          },
        },
      });

      if (!session) {
        return reply.status(404).send({ error: 'Sessione non trovata' });
      }

      if (!session.digitalConsent) {
        return reply.status(403).send({ error: 'Consenso digitale non fornito per questa transazione' });
      }

      const targetUuid = session.fiscalDocNumber || session.fiscalReceiptUrl?.split('/').pop();
      if (!targetUuid || targetUuid.startsWith('http')) {
        return reply.status(400).send('Nessun UUID scontrino fiscale valido per questa sessione.');
      }

      const venue = session.venue;
      if (!venue.acubeApiKey) {
        return reply.status(400).send('Configurazione A-Cube mancante per questo locale.');
      }

      const orgId = venue.acubeOrganizationId || 'dummy';
      // [FIX A] passa isProduction: in prod la chiave mock lancia (niente PDF finti)
      const { token, apiUrl, isMock } = await fiscalServices.getAcubeToken(
        venue.acubeApiKey,
        orgId,
        { isProduction: cfg.IS_PRODUCTION }
      );

      if (isMock) {
        return reply.redirect('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf');
      }

      const pdfResponse = await fetch(`${apiUrl}/receipts/${targetUuid}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/pdf',
          ...(orgId && orgId !== 'dummy' ? { 'X-Organization-Id': orgId } : {}),
        }
      });

      if (!pdfResponse.ok) {
        req.log.error(
          { upstreamStatus: pdfResponse.status },
          'Errore recupero PDF A-Cube'
        );
        return reply.status(pdfResponse.status).send({ error: 'Errore durante la generazione del PDF' });
      }

      const pdfBuffer = await pdfResponse.arrayBuffer();

      reply
        .type('application/pdf')
        .header('Content-Disposition', `inline; filename="receipt-${targetUuid}.pdf"`)
        .send(Buffer.from(pdfBuffer));

    } catch (err: any) {
      req.log.error(err);
      reply.status(500).send({ error: 'Errore interno del server' });
    }
  });

  // Rotte GET legacy disabilitate: richiedono POST autorizzato con wallet capability
  fastify.get('/api/receipt/:sessionId', async (_req, reply) => {
    return reply.status(401).send({ error: 'La visualizzazione dello scontrino richiede autenticazione tramite capability wallet' });
  });

  fastify.get('/api/receipt/pdf/:sessionId', async (_req, reply) => {
    return reply.status(401).send({ error: 'Il download del PDF richiede autenticazione tramite capability wallet' });
  });
}

// Retrocompat: wrapper che usa i singleton globali
export async function stripeRoutes(fastify: FastifyInstance) {
  const cfg = globalConfig;
  return registerStripeRoutes(fastify, {
    prisma: globalPrisma,
    config: cfg,
    stripe: new Stripe(cfg.STRIPE_API_KEY, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    }),
    fiscalServices: {
      ensureSessionInvoiced: defaultEnsureSessionInvoiced,
      getAcubeToken: defaultGetAcubeToken,
      voidAcubeReceipt: defaultVoidAcubeReceipt,
    },
  });
}
