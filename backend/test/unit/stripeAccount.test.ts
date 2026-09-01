import { describe, it, expect } from 'vitest';
import { validateStripeAccountId, extractStripeAccountPrefix } from '../../src/utils/stripeAccount';

describe('validateStripeAccountId [FIX 3.3]', () => {
  it('accetta stripeAccountId valido (acct_ + 16 alfanumerici)', () => {
    expect(validateStripeAccountId('acct_1NqK7x2eZvKYlo2C0')).toBe(true);
  });

  it('accetta stripeAccountId con 21+ caratteri', () => {
    expect(validateStripeAccountId('acct_1NqK7x2eZvKYlo2C0aBcDeFgH')).toBe(true);
  });

  it('rifiuta stringa vuota', () => {
    expect(validateStripeAccountId('')).toBe(false);
  });

  it('rifiuta null/undefined', () => {
    expect(validateStripeAccountId(null)).toBe(false);
    expect(validateStripeAccountId(undefined)).toBe(false);
  });

  it('rifiuta numero', () => {
    expect(validateStripeAccountId(12345)).toBe(false);
  });

  it('rifiuta stringa senza prefisso acct_', () => {
    expect(validateStripeAccountId('cus_1NqK7x2eZvKYlo2C0')).toBe(false);
    expect(validateStripeAccountId('1NqK7x2eZvKYlo2C0')).toBe(false);
  });

  it('rifiuta stripeAccountId troppo corto (< 21 char)', () => {
    expect(validateStripeAccountId('acct_short')).toBe(false); // 10 char
    expect(validateStripeAccountId('acct_1234567890')).toBe(false); // 15 char
  });

  it('rifiuta stringa con caratteri non alfanumerici dopo acct_', () => {
    expect(validateStripeAccountId('acct_1NqK-7x2eZvKYlo2C0')).toBe(false);
    expect(validateStripeAccountId('acct_1NqK_7x2eZvKYlo2C0')).toBe(false);
    expect(validateStripeAccountId('acct_1NqK 7x2eZvKYlo2C0')).toBe(false);
  });
});

describe('extractStripeAccountPrefix [FIX 3.3]', () => {
  it('estrae prefisso per accountId valido', () => {
    expect(extractStripeAccountPrefix('acct_1NqK7x2eZvKYlo2C0abcde')).toBe('acct_1Nq');
  });

  it('ritorna null per accountId invalido', () => {
    expect(extractStripeAccountPrefix('invalid')).toBeNull();
    expect(extractStripeAccountPrefix(null)).toBeNull();
  });
});
