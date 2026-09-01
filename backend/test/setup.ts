/**
 * Setup globale per i test del backend Sauta.
 * Carica variabili d'ambiente di test (non usa .env di produzione).
 *
 * I test devono essere indipendenti dal .env reale. Usiamo chiavi Stripe
 * test (sk_test_...) e un JWT_SECRET forte generato per i test.
 */

process.env.NODE_ENV = 'test';
process.env.STRIPE_API_KEY = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_unit_tests';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_placeholder_for_unit_tests';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_placeholder_for_unit_tests';
process.env.STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID || 'ca_test_placeholder';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-32chars-min-aaaaaaaaaaaaaa';
process.env.TICKET_JWT_SECRET = process.env.TICKET_JWT_SECRET || 'test-ticket-jwt-secret-32chars-bbbbbbbbbbbbb';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.BASE_URL = 'http://localhost:3001';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret-32chars-aaaaaaaaaaaaaa';
process.env.WORKOS_API_KEY = 'sk_test_workos_unit_key';
process.env.WORKOS_CLIENT_ID = 'client_workos_unit_id';
process.env.WORKOS_COOKIE_PASSWORD = 'test-workos-cookie-password-32-chars-long';
process.env.WORKOS_WEBHOOK_SECRET = 'whsec_workos_unit_secret';
process.env.WORKOS_REDIRECT_URI =
  'http://console.localhost:3001/api/auth/callback';
process.env.WORKOS_POST_LOGOUT_REDIRECT_URI =
  'http://console.localhost:3001';
process.env.CONSOLE_ORIGIN = 'http://console.localhost:3001';
process.env.AUTH_AUDIT_HMAC_SECRET =
  'test-auth-audit-hmac-secret-32-chars-long';
process.env.PLATFORM_ROOT_DOMAIN = 'sauta.test';
