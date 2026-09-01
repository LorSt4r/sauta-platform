import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createConfig } from '../../src/utils/config';
import { clearAuthCookie, setAuthCookie } from '../../src/routes/authGuards';

function makeConfig(nodeEnv: 'test' | 'production') {
  const consoleOrigin =
    nodeEnv === 'production'
      ? 'https://console.sauta.app'
      : 'http://console.localhost:3001';
  return createConfig({
    STRIPE_API_KEY: 'sk_test_auth_guards',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_auth_guards',
    STRIPE_WEBHOOK_SECRET: 'whsec_auth_guards',
    JWT_SECRET: 'auth-guards-jwt-secret-32-characters',
    TICKET_JWT_SECRET: 'auth-guards-ticket-secret-32-characters',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    ADMIN_SECRET: 'auth-guards-admin-secret-32-characters',
    NODE_ENV: nodeEnv,
    WORKOS_API_KEY: 'sk_test_workos_auth_guards',
    WORKOS_CLIENT_ID: 'client_workos_auth_guards',
    WORKOS_COOKIE_PASSWORD: 'auth-guards-cookie-password-32-characters',
    WORKOS_WEBHOOK_SECRET: 'whsec_workos_auth_guards',
    WORKOS_REDIRECT_URI: `${consoleOrigin}/api/auth/callback`,
    WORKOS_POST_LOGOUT_REDIRECT_URI: consoleOrigin,
    CONSOLE_ORIGIN: consoleOrigin,
    AUTH_AUDIT_HMAC_SECRET: 'auth-guards-audit-secret-32-characters',
    PLATFORM_ROOT_DOMAIN: nodeEnv === 'production' ? 'sauta.app' : 'sauta.test',
  });
}

describe('cookie AuthKit host-only', () => {
  it('in produzione usa __Host-, Secure, HttpOnly e Path root senza Domain', () => {
    const reply = {
      setCookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as FastifyReply;
    const config = makeConfig('production');

    setAuthCookie(reply, config, 'wos_session', 'sealed');
    clearAuthCookie(reply, config, 'wos_session');

    expect(reply.setCookie).toHaveBeenCalledWith(
      '__Host-wos_session',
      'sealed',
      expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        signed: true,
      })
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      '__Host-wos_session',
      'sealed',
      expect.not.objectContaining({ domain: expect.anything() })
    );
    expect(reply.clearCookie).toHaveBeenCalledWith('__Host-wos_session', {
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
  });

  it('in test HTTP usa nome separato e Secure false senza allentare Path/SameSite', () => {
    const reply = {
      setCookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as FastifyReply;
    const config = makeConfig('test');

    setAuthCookie(reply, config, 'wos_session', 'sealed');

    expect(reply.setCookie).toHaveBeenCalledWith(
      'wos_session',
      'sealed',
      expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        signed: true,
      })
    );
  });
});
