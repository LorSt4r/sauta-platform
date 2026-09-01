import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, type TicketPayload } from '../../src/utils/jwt';

const TEST_SECRET = 'test-secret-32-characters-long-aaaaaa';

describe('JWT signToken / verifyToken', () => {
  const payload: TicketPayload = { ticketId: 'ticket-123', venueId: 'venue-456' };

  it('firma e verifica un token valido', () => {
    const token = signToken(payload, TEST_SECRET);
    expect(token).toBeTruthy();
    const decoded = verifyToken(token, TEST_SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.ticketId).toBe('ticket-123');
    expect(decoded?.venueId).toBe('venue-456');
  });

  it('rigetta un token firmato con secret diverso', () => {
    const token = signToken(payload, TEST_SECRET);
    const decoded = verifyToken(token, 'altro-secret-sbagliato');
    expect(decoded).toBeNull();
  });

  it('rigetta un token manomesso', () => {
    const token = signToken(payload, TEST_SECRET);
    const tampered = token.slice(0, -5) + 'XXXXX';
    const decoded = verifyToken(tampered, TEST_SECRET);
    expect(decoded).toBeNull();
  });

  it('rigetta un token scaduto', async () => {
    // Firma con scadenza immediata (1ms)
    const token = signToken(payload, TEST_SECRET, { expiresIn: '1ms' });
    // Aspetta che scada
    await new Promise((r) => setTimeout(r, 50));
    const decoded = verifyToken(token, TEST_SECRET);
    expect(decoded).toBeNull();
  });

  it('genera token diversi per payload diversi', () => {
    const t1 = signToken({ ticketId: 'a', venueId: 'v1' }, TEST_SECRET);
    const t2 = signToken({ ticketId: 'b', venueId: 'v2' }, TEST_SECRET);
    expect(t1).not.toBe(t2);
  });

  it('verifica audience e subject quando richiesti', () => {
    const token = signToken(payload, TEST_SECRET, {
      audience: 'consume',
      subject: payload.ticketId,
    });
    const decoded = verifyToken(token, TEST_SECRET, { audience: 'consume' });
    expect(decoded?.sub).toBe(payload.ticketId);
    expect(verifyToken(token, TEST_SECRET, { audience: 'other' })).toBeNull();
  });
});
