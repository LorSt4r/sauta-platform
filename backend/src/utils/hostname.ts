import { domainToASCII } from 'node:url';

export type HostnameResult =
  | { ok: true; hostname: string }
  | { ok: false; error: string };

export const PUBLIC_HOSTNAME_ERROR = 'Invalid hostname format';

/**
 * Normalizza e valida un hostname grezzo.
 * Funzione pura senza side effect, DB o dipendenze da Fastify.
 * Non fa echo dell'input grezzo nei messaggi di errore.
 */
export function normalizeHostname(rawHost?: string | null): HostnameResult {
  if (!rawHost || typeof rawHost !== 'string') {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  const trimmed = rawHost.trim();
  if (!trimmed) {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  // Rifiuta URL schema, path, query, fragment, userinfo, virgole/forwarded multipli
  if (
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('@') ||
    trimmed.includes(',')
  ) {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  // Gestione eventuale porta finale (es. :443, :5173)
  let hostWithoutPort = trimmed;
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon !== -1) {
    // Rifiuta IPv6 con parentesi o multipli colons
    if (trimmed.indexOf(':') !== lastColon || trimmed.includes('[') || trimmed.includes(']')) {
      return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
    }
    const portStr = trimmed.slice(lastColon + 1);
    const portNum = Number(portStr);
    if (!/^\d+$/.test(portStr) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
    }
    hostWithoutPort = trimmed.slice(0, lastColon);
  }

  // Rimuove un singolo trailing dot se presente
  if (hostWithoutPort.endsWith('.')) {
    hostWithoutPort = hostWithoutPort.slice(0, -1);
    // Se finisce ancora con un punto (es. bar.sauta.app..), rifiuta
    if (hostWithoutPort.endsWith('.')) {
      return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
    }
  }

  if (!hostWithoutPort) {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  // Conversione IDN (punycode) e lowercase
  let asciiHost = '';
  try {
    asciiHost = domainToASCII(hostWithoutPort.toLowerCase());
  } catch {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  if (!asciiHost || asciiHost.length > 253) {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  // Rifiuta indirizzi IP (IPv4)
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(asciiHost)) {
    return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
  }

  // Validazione delle singole label DNS
  const labels = asciiHost.split('.');
  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith('-') ||
      label.endsWith('-') ||
      !/^[a-z0-9-]+$/.test(label)
    ) {
      return { ok: false, error: PUBLIC_HOSTNAME_ERROR };
    }
  }

  return { ok: true, hostname: asciiHost };
}
