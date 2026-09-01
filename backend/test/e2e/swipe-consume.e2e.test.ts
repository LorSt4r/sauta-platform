import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { cleanupE2eTest, setupE2eTest } from './e2e-helper';
import { generateWalletToken, hashWalletToken } from '../../src/utils/capability';
import { signToken } from '../../src/utils/jwt';

describe('Swipe to Consume E2E — Wave 9B', () => {
  let prisma: PrismaClient;
  let baseUrl: string;
  const ticketSecret =
    process.env.TICKET_JWT_SECRET || 'test-ticket-jwt-secret-32chars-bbbbbbbbbbbbb';

  beforeAll(async () => {
    const setup = await setupE2eTest();
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  async function createTicket(status = 'valid') {
    const venue = await prisma.venue.create({ data: { name: `Consume Venue ${crypto.randomUUID()}` } });
    const session = await prisma.checkoutSession.create({
      data: { venueId: venue.id, totalAmount: 1000, status: 'paid' },
    });
    const ticket = await prisma.ticket.create({
      data: {
        sessionId: session.id,
        venueId: venue.id,
        productName: 'gin-tonic',
        price: 1000,
        status,
      },
    });
    const walletToken = generateWalletToken();
    await prisma.walletCapability.create({
      data: {
        sessionId: session.id,
        tokenHash: hashWalletToken(walletToken),
      },
    });
    return { venue, session, ticket, walletToken };
  }

  async function requestConsumeToken(
    fixture: Awaited<ReturnType<typeof createTicket>>
  ): Promise<string> {
    const response = await fetch(`${baseUrl}/api/wallet/consume-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: fixture.session.id,
        token: fixture.walletToken,
        ticketId: fixture.ticket.id,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { consumeToken: string };
    return body.consumeToken;
  }

  it('consuma un ticket autorizzato e salva usedAt', async () => {
    const fixture = await createTicket();
    const consumeToken = await requestConsumeToken(fixture);
    const startedAt = Date.now();

    const response = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });

    expect(response.status).toBe(200);
    const updated = await prisma.ticket.findUnique({ where: { id: fixture.ticket.id } });
    expect(updated?.status).toBe('used');
    expect(updated?.usedAt?.getTime()).toBeGreaterThanOrEqual(startedAt);
  });

  it('rende atomico il doppio swipe concorrente', async () => {
    const fixture = await createTicket();
    const consumeToken = await requestConsumeToken(fixture);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${baseUrl}/api/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumeToken }),
      }))
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(4);
  });

  it('nega capability errata prima di emettere il consume token', async () => {
    const fixture = await createTicket();
    const response = await fetch(`${baseUrl}/api/wallet/consume-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: fixture.session.id,
        token: generateWalletToken(),
        ticketId: fixture.ticket.id,
      }),
    });
    expect(response.status).toBe(401);
  });

  it('rifiuta token scaduti, senza audience o con subject errato', async () => {
    const fixture = await createTicket();
    const variants = [
      signToken(
        { ticketId: fixture.ticket.id, venueId: fixture.venue.id },
        ticketSecret,
        { expiresIn: '-1s', audience: 'consume', subject: fixture.ticket.id }
      ),
      signToken(
        { ticketId: fixture.ticket.id, venueId: fixture.venue.id },
        ticketSecret,
        { expiresIn: '5m', subject: fixture.ticket.id }
      ),
      signToken(
        { ticketId: fixture.ticket.id, venueId: fixture.venue.id },
        ticketSecret,
        { expiresIn: '5m', audience: 'consume', subject: 'wrong-ticket' }
      ),
    ];

    for (const consumeToken of variants) {
      const response = await fetch(`${baseUrl}/api/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumeToken }),
      });
      expect(response.status).toBe(401);
    }
  });

  it('rifiuta campi legacy e stati ticket non validi senza distinguere il motivo', async () => {
    const fixture = await createTicket('voided');
    const legacyResponse = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'legacy' }),
    });
    expect(legacyResponse.status).toBe(400);

    const consumeToken = signToken(
      { ticketId: fixture.ticket.id, venueId: fixture.venue.id },
      ticketSecret,
      { expiresIn: '5m', audience: 'consume', subject: fixture.ticket.id }
    );
    const response = await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });
    expect(response.status).toBe(409);
  });

  it('il wallet autorizzato riflette lo stato used dopo lo swipe', async () => {
    const fixture = await createTicket();
    const consumeToken = await requestConsumeToken(fixture);
    await fetch(`${baseUrl}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken }),
    });

    const response = await fetch(`${baseUrl}/api/wallet/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ sessionId: fixture.session.id, token: fixture.walletToken }],
      }),
    });
    const body = await response.json() as {
      sessions: Array<{ tickets: Array<{ id: string; status: string }> }>;
    };
    expect(response.status).toBe(200);
    expect(body.sessions[0]?.tickets.find((ticket) => ticket.id === fixture.ticket.id)?.status)
      .toBe('used');
  });
});
