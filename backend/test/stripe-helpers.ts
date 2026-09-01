import Stripe from 'stripe';

/**
 * Helper per costruire webhook eventi Stripe con firma reale.
 * Usa stripe.webhooks.generateTestHeaderString per generare la stripe-signature
 * header con la chiave segreta — verifica crittografica reale, non mock.
 */
export function buildWebhookPayload(
  eventType: string,
  data: Record<string, any>
): string {
  return JSON.stringify({
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: eventType,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
  });
}

export function buildPaymentIntentSucceededEvent(
  sessionId: string,
  venueId: string,
  amount: number,
  paymentIntentId: string = `pi_test_${Date.now()}`
): { payload: string; paymentIntentId: string } {
  const payload = buildWebhookPayload('payment_intent.succeeded', {
    id: paymentIntentId,
    object: 'payment_intent',
    amount,
    currency: 'eur',
    status: 'succeeded',
    metadata: { sessionId, venueId },
  });
  return { payload, paymentIntentId };
}

/**
 * Genera l'header stripe-signature per un payload dato il secret.
 * Questo è il modo reale di testare la verifica firma (non mock).
 */
export function generateWebhookSignature(
  stripe: Stripe,
  payload: string,
  secret: string,
  timestamp?: number
): string {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  });
}

/**
 * Costruisce un webhook event completo con rawBody + firma valida.
 * Usato per test che simulano webhook (es. account.updated).
 */
export function constructWebhookEvent(event: any): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(event);
  const stripe = new Stripe(process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || 'sk_test', {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test',
  });
  return { rawBody, signature };
}
