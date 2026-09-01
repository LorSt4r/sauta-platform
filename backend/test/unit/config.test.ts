import { describe, it, expect } from 'vitest';
import {
  createConfig,
  parseAllowedOrigins,
  parseTrustProxy,
  rejectPlaceholder,
} from '../../src/utils/config';

describe('createConfig', () => {
  const validEnv = {
    STRIPE_API_KEY: 'sk_test_abc123',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123',
    STRIPE_WEBHOOK_SECRET: 'whsec_realsecret123',
    JWT_SECRET: 'very-strong-secret-32-chars-long-aaaaa',
    TICKET_JWT_SECRET: 'very-strong-ticket-secret-32-chars-bbbbb',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    NODE_ENV: 'test',
    WORKOS_API_KEY: 'sk_test_workos_key',
    WORKOS_CLIENT_ID: 'client_workos_id',
    WORKOS_COOKIE_PASSWORD: 'test-workos-cookie-password-32-chars-long-aaaa',
    WORKOS_WEBHOOK_SECRET: 'whsec_workos_secret',
    WORKOS_REDIRECT_URI: 'http://console.localhost:3001/api/auth/callback',
    WORKOS_POST_LOGOUT_REDIRECT_URI: 'http://console.localhost:3001',
    CONSOLE_ORIGIN: 'http://console.localhost:3001',
    AUTH_AUDIT_HMAC_SECRET: 'test-auth-audit-hmac-secret-32-chars-bbbbb',
    PLATFORM_ROOT_DOMAIN: 'sauta.test',
  };

  it('crea config valida con tutte le env obbligatorie', () => {
    const cfg = createConfig(validEnv);
    expect(cfg.STRIPE_API_KEY).toBe('sk_test_abc123');
    expect(cfg.IS_PRODUCTION).toBe(false);
    expect(cfg.PORT).toBe(3001);
    expect(cfg.CONSOLE_ORIGIN).toBe('http://console.localhost:3001');
  });

  it('lancia se manca una env obbligatoria', () => {
    expect(() => createConfig({ ...validEnv, STRIPE_API_KEY: undefined })).toThrow(
      'STRIPE_API_KEY'
    );
    expect(() => createConfig({ ...validEnv, JWT_SECRET: undefined })).toThrow('JWT_SECRET');
    expect(() =>
      createConfig({
        ...validEnv,
        NODE_ENV: 'production',
        ADMIN_SECRET: 'real-admin-secret-32-chars-aaaa',
        WORKOS_COOKIE_PASSWORD: undefined,
      })
    ).toThrow('WORKOS_COOKIE_PASSWORD');
    expect(() => createConfig({ ...validEnv, CONSOLE_ORIGIN: undefined })).toThrow(
      'CONSOLE_ORIGIN'
    );
    expect(() =>
      createConfig({ ...validEnv, WORKOS_REDIRECT_URI: undefined })
    ).toThrow('WORKOS_REDIRECT_URI');
    expect(() =>
      createConfig({ ...validEnv, WORKOS_POST_LOGOUT_REDIRECT_URI: undefined })
    ).toThrow('WORKOS_POST_LOGOUT_REDIRECT_URI');
  });

  it('rifiuta WORKOS_COOKIE_PASSWORD o AUTH_AUDIT_HMAC_SECRET sotto i 32 caratteri', () => {
    expect(() =>
      createConfig({ ...validEnv, WORKOS_COOKIE_PASSWORD: 'short-password' })
    ).toThrow('32 caratteri');
    expect(() =>
      createConfig({ ...validEnv, AUTH_AUDIT_HMAC_SECRET: 'short-secret' })
    ).toThrow('32 caratteri');
  });

  it('rifiuta WORKOS_REDIRECT_URI se la origin non coincide con CONSOLE_ORIGIN', () => {
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_REDIRECT_URI: 'http://other.localhost:3001/api/auth/callback',
      })
    ).toThrow('stessa origin');
  });

  it('richiede una CONSOLE_ORIGIN canonica e HTTPS in produzione', () => {
    expect(() =>
      createConfig({
        ...validEnv,
        CONSOLE_ORIGIN: 'http://console.localhost:3001/',
      })
    ).toThrow('origin');
    expect(() =>
      createConfig({
        ...validEnv,
        NODE_ENV: 'production',
        ADMIN_SECRET: 'real-admin-secret-32-chars-aaaa',
      })
    ).toThrow('HTTPS');
  });

  it('rifiuta query e fragment nella callback WorkOS', () => {
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_REDIRECT_URI:
          'http://console.localhost:3001/api/auth/callback?unexpected=true',
      })
    ).toThrow('query');
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_REDIRECT_URI:
          'http://console.localhost:3001/api/auth/callback#fragment',
      })
    ).toThrow('fragment');
  });

  it('rifiuta i placeholder WorkOS documentati in .env.example', () => {
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_API_KEY: 'sk_test_workos_api_key_placeholder',
      })
    ).toThrow('placeholder');
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_CLIENT_ID: 'client_workos_client_id_placeholder',
      })
    ).toThrow('placeholder');
    expect(() =>
      createConfig({
        ...validEnv,
        WORKOS_WEBHOOK_SECRET: 'whsec_workos_webhook_secret_placeholder',
      })
    ).toThrow('placeholder');
  });

  it('riconosce IS_PRODUCTION quando NODE_ENV=production', () => {
    const cfg = createConfig({
      ...validEnv,
      NODE_ENV: 'production',
      ADMIN_SECRET: 'real-admin-secret-32-chars-aaaa',
      CONSOLE_ORIGIN: 'https://console.sauta.app',
      WORKOS_REDIRECT_URI: 'https://console.sauta.app/api/auth/callback',
      WORKOS_POST_LOGOUT_REDIRECT_URI: 'https://console.sauta.app',
    });
    expect(cfg.IS_PRODUCTION).toBe(true);
  });

  it('mantiene i default delle env opzionali', () => {
    const cfg = createConfig(validEnv);
    expect(cfg.PORT).toBe(3001);
    expect(cfg.BASE_URL).toBe('http://localhost:3001');
    expect(cfg.ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
    expect(cfg.TRUST_PROXY).toBe(false);
  });

  it('continua a rifiutare i placeholder Stripe e JWT', () => {
    expect(() =>
      createConfig({
        ...validEnv,
        STRIPE_WEBHOOK_SECRET: 'whsec_REPLACE_ME_WITH_STRIPE_CLI_SECRET',
      })
    ).toThrow('STRIPE_WEBHOOK_SECRET');
    expect(() =>
      createConfig({ ...validEnv, STRIPE_WEBHOOK_SECRET: 'whsec_demo' })
    ).toThrow('STRIPE_WEBHOOK_SECRET');
    expect(() =>
      createConfig({ ...validEnv, JWT_SECRET: 'super-secret-sauta-key' })
    ).toThrow('JWT_SECRET');
  });

  it('parsa ALLOWED_ORIGINS come array', () => {
    const cfg = createConfig({
      ...validEnv,
      ALLOWED_ORIGINS: 'https://a.com,https://b.com',
    });
    expect(cfg.ALLOWED_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('rifiuta wildcard, origin non canoniche e protocolli non HTTP', () => {
    expect(() => parseAllowedOrigins('*')).toThrow('wildcard');
    expect(() => parseAllowedOrigins('https://a.com/path')).toThrow(
      'origin non valida'
    );
    expect(() => parseAllowedOrigins('javascript:alert(1)')).toThrow(
      'origin non valida'
    );
    expect(parseAllowedOrigins('https://a.com, https://a.com')).toEqual([
      'https://a.com',
    ]);
  });
});

describe('parseTrustProxy', () => {
  it('parsa booleani e hop count espliciti', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
  });

  it('fallisce chiuso sui valori non validi', () => {
    expect(parseTrustProxy('yes')).toBe(false);
    expect(parseTrustProxy('1.5')).toBe(false);
    expect(parseTrustProxy('-1')).toBe(false);
  });
});

describe('rejectPlaceholder', () => {
  it('accetta valori reali', () => {
    expect(() => rejectPlaceholder('X', 'realvalue', ['placeholder'])).not.toThrow();
  });

  it('rifiuta placeholder esatti', () => {
    expect(() => rejectPlaceholder('X', 'placeholder', ['placeholder'])).toThrow('placeholder');
  });

  it('rifiuta placeholder come prefisso', () => {
    expect(() =>
      rejectPlaceholder('X', 'whsec_REPLACE_ME_with_real', ['whsec_REPLACE_ME'])
    ).toThrow('placeholder');
  });
});
