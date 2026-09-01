import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../../src/utils/config';
import { createWorkosIdentityProvider } from '../../src/utils/identityProvider';
import {
  isTransientIssuedAtValid,
  normalizeConsoleReturnTo,
  normalizeWorkosEmail,
} from '../../src/routes/authRoutes';

const config = createConfig({
  STRIPE_API_KEY: 'sk_test_identity_provider',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_identity_provider',
  STRIPE_WEBHOOK_SECRET: 'whsec_identity_provider',
  JWT_SECRET: 'identity-provider-jwt-secret-32-chars',
  TICKET_JWT_SECRET: 'identity-provider-ticket-secret-32-chars',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  NODE_ENV: 'test',
  WORKOS_API_KEY: 'sk_test_workos_identity_provider',
  WORKOS_CLIENT_ID: 'client_workos_identity_provider',
  WORKOS_COOKIE_PASSWORD: 'identity-provider-cookie-password-32-chars',
  WORKOS_WEBHOOK_SECRET: 'whsec_workos_identity_provider',
  WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
  WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
  CONSOLE_ORIGIN: 'http://console.localhost:3001',
  PLATFORM_ROOT_DOMAIN: 'sauta.test',
  AUTH_AUDIT_HMAC_SECRET: 'identity-provider-audit-secret-32-chars',
});

describe('WorkOS identity provider boundary', () => {
  it('genera localmente authorization URL, state e PKCE senza rete', async () => {
    const provider = createWorkosIdentityProvider(config);
    const result = await provider.getAuthorizationUrlWithPKCE({
      state: 'state_local_pkce',
      redirectUri: config.WORKOS_REDIRECT_URI,
    });
    const url = new URL(result.url);

    expect(url.searchParams.get('state')).toBe('state_local_pkce');
    expect(url.searchParams.get('redirect_uri')).toBe(
      config.WORKOS_REDIRECT_URI
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('verifica localmente una firma webhook con il vero helper SDK', async () => {
    const provider = createWorkosIdentityProvider(config);
    const payload = JSON.stringify({
      id: 'event_01JTEST',
      event: 'organization_membership.updated',
      created_at: new Date().toISOString(),
      data: {
        id: 'om_01JTEST',
        user_id: 'user_01JTEST',
        organization_id: 'org_01JTEST',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const timestamp = String(Date.now());
    const signature = crypto
      .createHmac('sha256', config.WORKOS_WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    const event = await provider.verifyWebhookSignature({
      payload,
      sigHeader: `t=${timestamp},v1=${signature}`,
    });

    expect(event.id).toBe('event_01JTEST');
    expect(event.event).toBe('organization_membership.updated');
    expect(event.data).toMatchObject({
      id: 'om_01JTEST',
      userId: 'user_01JTEST',
      organizationId: 'org_01JTEST',
      status: 'active',
    });
  });

  it('rifiuta una firma webhook non valida senza chiamate di rete', async () => {
    const provider = createWorkosIdentityProvider(config);
    const timestamp = String(Date.now());

    await expect(
      provider.verifyWebhookSignature({
        payload: JSON.stringify({
          id: 'event_invalid',
          event: 'user.updated',
          created_at: new Date().toISOString(),
          data: {},
        }),
        sigHeader: `t=${timestamp},v1=invalid`,
      })
    ).rejects.toThrow();
  });
});

describe('AuthKit pure normalization and transient timestamp rules', () => {
  it('normalizza email verificata con trim e lowercase', () => {
    expect(normalizeWorkosEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('consente soltanto il returnTo relativo allowlisted della console', () => {
    expect(normalizeConsoleReturnTo('/console')).toBe('/console');
    expect(normalizeConsoleReturnTo('/console?tab=venue')).toBe(
      '/console?tab=venue'
    );
    expect(normalizeConsoleReturnTo('//evil.example/console')).toBe('/console');
    expect(normalizeConsoleReturnTo('/console.evil')).toBe('/console');
    expect(normalizeConsoleReturnTo('https://evil.example/console')).toBe(
      '/console'
    );
  });

  it('accetta soltanto issuedAt intero, non futuro e non più vecchio di 10 minuti', () => {
    const now = 1_800_000_000_000;
    expect(isTransientIssuedAtValid(now - 600_000, now)).toBe(true);
    expect(isTransientIssuedAtValid(now - 600_001, now)).toBe(false);
    expect(isTransientIssuedAtValid(now + 1, now)).toBe(false);
    expect(isTransientIssuedAtValid(Number.NaN, now)).toBe(false);
    expect(isTransientIssuedAtValid('1800000000000', now)).toBe(false);
  });
});
