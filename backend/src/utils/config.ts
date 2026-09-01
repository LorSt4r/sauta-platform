/**
 * Configurazione centralizzata del backend Sauta.
 *
 * Architettura testabile: `createConfig(env)` factory che legge env da un
 * oggetto passato (default `process.env`). I test possono passare un env
 * custom senza toccare `process.env` globale.
 *
 * NOTA WAVE 9A: `config.ts` non esegue più `createConfig()` a module-load.
 * I moduli e l'entrypoint devono costruire le dipendenze in modo esplicito.
 */

export interface AppConfig {
  STRIPE_API_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_CLIENT_ID: string;
  JWT_SECRET: string;
  TICKET_JWT_SECRET: string;
  DATABASE_URL: string;
  PORT: number;
  NODE_ENV: string;
  IS_PRODUCTION: boolean;
  BASE_URL: string;
  ALLOWED_ORIGINS: string[];
  ADMIN_SECRET: string;
  TRUST_PROXY: boolean | number;

  // Wave 9C.0B WorkOS & Console Identity Config
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD: string;
  WORKOS_WEBHOOK_SECRET: string;
  WORKOS_REDIRECT_URI: string;
  WORKOS_POST_LOGOUT_REDIRECT_URI: string;
  CONSOLE_ORIGIN: string;
  AUTH_AUDIT_HMAC_SECRET: string;
  PLATFORM_ROOT_DOMAIN: string;
}

export function requireEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[CONFIG] Variabile d'ambiente obbligatoria mancante o vuota: ${name}. ` +
      `Impostala nel file .env o nell'ambiente di esecuzione.`
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback: string, env: Record<string, string | undefined>): string {
  return env[name] || fallback;
}

export function rejectPlaceholder(name: string, value: string, placeholders: string[] = []): void {
  const normalized = value.trim();
  for (const p of placeholders) {
    if (normalized === p || normalized.startsWith(p)) {
      throw new Error(
        `[CONFIG] ${name} contiene un placeholder non valido (${normalized}). ` +
        `Imposta un valore reale prima di avviare il server.`
      );
    }
  }
}

export function parseTrustProxy(value: string | boolean | number | undefined): boolean | number {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  const n = parseInt(v, 10);
  if (!Number.isNaN(n) && n >= 0 && String(n) === v) return n;
  return false;
}

export function parseAllowedOrigins(raw: string): string[] {
  const origins = Array.from(
    new Set(raw.split(',').map((origin) => origin.trim()).filter(Boolean))
  );
  if (origins.length === 0) {
    throw new Error('[CONFIG] ALLOWED_ORIGINS deve contenere almeno una origin esplicita.');
  }
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('[CONFIG] ALLOWED_ORIGINS non può contenere wildcard con credenziali.');
    }
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        origin !== parsed.origin
      ) {
        throw new Error('origin non canonica');
      }
    } catch {
      throw new Error(`[CONFIG] ALLOWED_ORIGINS contiene una origin non valida: ${origin}.`);
    }
  }
  return origins;
}

export function createConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Supporta sia STRIPE_API_KEY che il fallback legacy STRIPE_SECRET_KEY durante la transizione
  const STRIPE_API_KEY = env.STRIPE_API_KEY || env.STRIPE_SECRET_KEY;
  if (!STRIPE_API_KEY || STRIPE_API_KEY.trim() === '') {
    throw new Error(
      `[CONFIG] Variabile d'ambiente obbligatoria mancante o vuota: STRIPE_API_KEY. ` +
      `Impostala nel file .env o nell'ambiente di esecuzione.`
    );
  }
  const STRIPE_PUBLISHABLE_KEY = requireEnv('STRIPE_PUBLISHABLE_KEY', env);
  const STRIPE_WEBHOOK_SECRET = requireEnv('STRIPE_WEBHOOK_SECRET', env);
  const JWT_SECRET = requireEnv('JWT_SECRET', env);
  const TICKET_JWT_SECRET = requireEnv('TICKET_JWT_SECRET', env);
  const DATABASE_URL = requireEnv('DATABASE_URL', env);

  rejectPlaceholder('STRIPE_WEBHOOK_SECRET', STRIPE_WEBHOOK_SECRET, [
    'whsec_REPLACE_ME',
    'whsec_demo',
  ]);
  rejectPlaceholder('JWT_SECRET', JWT_SECRET, [
    'super-secret-sauta-key',
    'super-secret-sauta-key-change-me',
    'change-me',
  ]);
  rejectPlaceholder('TICKET_JWT_SECRET', TICKET_JWT_SECRET, [
    'super-secret-sauta-key',
    'super-secret-sauta-key-change-me',
    'change-me',
  ]);

  const NODE_ENV = optionalEnv('NODE_ENV', 'development', env);
  const PORT = parseInt(optionalEnv('PORT', '3001', env), 10);
  const IS_PRODUCTION = NODE_ENV === 'production';
  const BASE_URL = optionalEnv('BASE_URL', 'http://localhost:3001', env);
  const ALLOWED_ORIGINS = parseAllowedOrigins(
    optionalEnv('ALLOWED_ORIGINS', 'http://localhost:5173', env)
  );
  const TRUST_PROXY = parseTrustProxy(optionalEnv('TRUST_PROXY', 'false', env));

  const STRIPE_CLIENT_ID = optionalEnv('STRIPE_CLIENT_ID', 'ca_test_placeholder', env);
  let ADMIN_SECRET: string;
  if (IS_PRODUCTION) {
    ADMIN_SECRET = requireEnv('ADMIN_SECRET', env);
    rejectPlaceholder('ADMIN_SECRET', ADMIN_SECRET, [
      'admin-secret-change-me',
      'change-me',
    ]);
  } else {
    ADMIN_SECRET = optionalEnv('ADMIN_SECRET', 'dev-admin-secret-not-for-production', env);
  }

  // WorkOS & Console Identity Config (Wave 9C.0B).
  // Tutti i valori sono espliciti in ogni ambiente: anche test e sviluppo
  // devono costruire una configurazione sintetica completa.
  const WORKOS_API_KEY = requireEnv('WORKOS_API_KEY', env);
  const WORKOS_CLIENT_ID = requireEnv('WORKOS_CLIENT_ID', env);
  const WORKOS_COOKIE_PASSWORD = requireEnv('WORKOS_COOKIE_PASSWORD', env);
  const WORKOS_WEBHOOK_SECRET = requireEnv('WORKOS_WEBHOOK_SECRET', env);
  const WORKOS_REDIRECT_URI = requireEnv('WORKOS_REDIRECT_URI', env);
  const WORKOS_POST_LOGOUT_REDIRECT_URI = requireEnv(
    'WORKOS_POST_LOGOUT_REDIRECT_URI',
    env
  );
  const CONSOLE_ORIGIN = requireEnv('CONSOLE_ORIGIN', env);
  const AUTH_AUDIT_HMAC_SECRET = requireEnv('AUTH_AUDIT_HMAC_SECRET', env);

  rejectPlaceholder('WORKOS_API_KEY', WORKOS_API_KEY, [
    'sk_test_workos_placeholder',
    'sk_test_workos_api_key_placeholder',
  ]);
  rejectPlaceholder('WORKOS_CLIENT_ID', WORKOS_CLIENT_ID, [
    'client_workos_placeholder',
    'client_workos_client_id_placeholder',
  ]);
  rejectPlaceholder('WORKOS_COOKIE_PASSWORD', WORKOS_COOKIE_PASSWORD, [
    'min_32_chars_cookie_password_secret_here!',
  ]);
  rejectPlaceholder('WORKOS_WEBHOOK_SECRET', WORKOS_WEBHOOK_SECRET, [
    'whsec_workos_placeholder',
    'whsec_workos_webhook_secret_placeholder',
  ]);
  rejectPlaceholder('AUTH_AUDIT_HMAC_SECRET', AUTH_AUDIT_HMAC_SECRET, [
    'min_32_chars_auth_audit_hmac_secret_here!',
  ]);

  if (WORKOS_COOKIE_PASSWORD.length < 32) {
    throw new Error('[CONFIG] WORKOS_COOKIE_PASSWORD deve contenere almeno 32 caratteri.');
  }

  if (AUTH_AUDIT_HMAC_SECRET.length < 32) {
    throw new Error('[CONFIG] AUTH_AUDIT_HMAC_SECRET deve contenere almeno 32 caratteri.');
  }

  // CONSOLE_ORIGIN deve essere già nella forma canonica restituita dal browser
  // nell'header Origin, altrimenti il confronto CSRF esatto fallirebbe.
  try {
    const consoleUrl = new URL(CONSOLE_ORIGIN);
    if (
      (consoleUrl.protocol !== 'http:' && consoleUrl.protocol !== 'https:') ||
      CONSOLE_ORIGIN !== consoleUrl.origin
    ) {
      throw new Error('[CONFIG] CONSOLE_ORIGIN deve essere una origin senza path, query o fragment.');
    }
    if (IS_PRODUCTION && consoleUrl.protocol !== 'https:') {
      throw new Error('[CONFIG] CONSOLE_ORIGIN deve usare HTTPS in produzione.');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'valore non valido';
    throw new Error(`[CONFIG] CONSOLE_ORIGIN non è un'URL origin valida: ${message}`);
  }

  // Validazione WORKOS_REDIRECT_URI (stessa origin di CONSOLE_ORIGIN, path /api/auth/callback)
  try {
    const redirectUrl = new URL(WORKOS_REDIRECT_URI);
    const consoleUrl = new URL(CONSOLE_ORIGIN);
    if (redirectUrl.origin !== consoleUrl.origin) {
      throw new Error('[CONFIG] WORKOS_REDIRECT_URI deve avere la stessa origin di CONSOLE_ORIGIN.');
    }
    if (redirectUrl.pathname !== '/api/auth/callback') {
      throw new Error('[CONFIG] WORKOS_REDIRECT_URI deve avere path esatto /api/auth/callback.');
    }
    if (
      redirectUrl.search !== '' ||
      redirectUrl.hash !== '' ||
      redirectUrl.username !== '' ||
      redirectUrl.password !== ''
    ) {
      throw new Error('[CONFIG] WORKOS_REDIRECT_URI non deve contenere credenziali, query o fragment.');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'valore non valido';
    throw new Error(`[CONFIG] WORKOS_REDIRECT_URI non valida: ${message}`);
  }

  // Validazione WORKOS_POST_LOGOUT_REDIRECT_URI (stessa origin)
  try {
    const logoutUrl = new URL(WORKOS_POST_LOGOUT_REDIRECT_URI);
    const consoleUrl = new URL(CONSOLE_ORIGIN);
    if (logoutUrl.origin !== consoleUrl.origin) {
      throw new Error('[CONFIG] WORKOS_POST_LOGOUT_REDIRECT_URI deve avere la stessa origin di CONSOLE_ORIGIN.');
    }
    if (logoutUrl.username !== '' || logoutUrl.password !== '') {
      throw new Error('[CONFIG] WORKOS_POST_LOGOUT_REDIRECT_URI non deve contenere credenziali.');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'valore non valido';
    throw new Error(`[CONFIG] WORKOS_POST_LOGOUT_REDIRECT_URI non valida: ${message}`);
  }

  const PLATFORM_ROOT_DOMAIN = requireEnv('PLATFORM_ROOT_DOMAIN', env).trim().toLowerCase();

  rejectPlaceholder('PLATFORM_ROOT_DOMAIN', PLATFORM_ROOT_DOMAIN, [
    'sauta.test.placeholder',
    'example.com',
  ]);

  if (
    PLATFORM_ROOT_DOMAIN.includes('/') ||
    PLATFORM_ROOT_DOMAIN.includes(':') ||
    PLATFORM_ROOT_DOMAIN.includes('*') ||
    PLATFORM_ROOT_DOMAIN.startsWith('.') ||
    PLATFORM_ROOT_DOMAIN.endsWith('.') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(PLATFORM_ROOT_DOMAIN)
  ) {
    throw new Error(
      `[CONFIG] PLATFORM_ROOT_DOMAIN non è un hostname valido: ${PLATFORM_ROOT_DOMAIN}. ` +
      `Deve essere un dominio puro senza schema, porta, path o wildcard (es. sauta.app).`
    );
  }

  return {
    STRIPE_API_KEY,
    STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_CLIENT_ID,
    JWT_SECRET,
    TICKET_JWT_SECRET,
    DATABASE_URL,
    PORT,
    NODE_ENV,
    IS_PRODUCTION,
    BASE_URL,
    ALLOWED_ORIGINS,
    ADMIN_SECRET,
    TRUST_PROXY,
    WORKOS_API_KEY,
    WORKOS_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD,
    WORKOS_WEBHOOK_SECRET,
    WORKOS_REDIRECT_URI,
    WORKOS_POST_LOGOUT_REDIRECT_URI,
    CONSOLE_ORIGIN,
    AUTH_AUDIT_HMAC_SECRET,
    PLATFORM_ROOT_DOMAIN,
  };
}

// Proxy per retrocompatibilità legacy senza esecuzione anticipata a import-time
let cachedConfig: AppConfig | null = null;
export const config = new Proxy({} as AppConfig, {
  get(_, prop: keyof AppConfig) {
    if (!cachedConfig) {
      cachedConfig = createConfig();
    }
    return cachedConfig[prop];
  },
});
