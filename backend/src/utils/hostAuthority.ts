/**
 * Native HTTP Host authority parser for Sauta.
 *
 * Rules (ADR-002 & HANDOFF_ACTIVE.md):
 * 1. Authority derives ONLY from the native `Host` header.
 * 2. `X-Forwarded-Host` and RFC `Forwarded` headers are NEVER used to select tenant or console.
 * 3. Missing, multiple, malformed, or invalid hostnames fail closed (type = UNKNOWN).
 * 4. Hostname is normalized to lowercase, trimmed, with trailing dot / port removed.
 */

export type HostType = 'CONSOLE' | 'PLATFORM_ROOT' | 'PLATFORM_SUBDOMAIN' | 'CUSTOM' | 'UNKNOWN';

export interface HostAuthorityResult {
  rawHost: string;
  hostname: string;
  port: number | null;
  isValid: boolean;
  type: HostType;
  slug: string | null;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return /^\[[a-f0-9:]+\]$/.test(hostname);
  }
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  return labels.every((label) => DNS_LABEL.test(label));
}

export function isFingerprintAssetPath(rawUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://sauta.invalid').pathname;
  } catch {
    return false;
  }
  return /^\/assets\/[^/]+-[a-z0-9_-]{8,}\.[a-z0-9]+$/i.test(pathname);
}

/**
 * Parses raw Host header value strictly.
 */
export function parseHostAuthority(
  rawHostHeader: string | string[] | undefined,
  config: { CONSOLE_ORIGIN: string; PLATFORM_ROOT_DOMAIN: string }
): HostAuthorityResult {
  const invalidResult = (raw: string): HostAuthorityResult => ({
    rawHost: raw,
    hostname: '',
    port: null,
    isValid: false,
    type: 'UNKNOWN',
    slug: null,
  });

  if (!rawHostHeader) {
    return invalidResult('');
  }

  // Reject multiple Host headers (e.g. Host: a.com, b.com)
  if (Array.isArray(rawHostHeader)) {
    return invalidResult(rawHostHeader.join(', '));
  }

  const raw = rawHostHeader.trim();
  if (!raw || raw.includes(',')) {
    return invalidResult(raw);
  }

  // Normalize: lowercase and strip trailing dot if present before port
  const hostPart = raw.toLowerCase();

  // Extract port if present (e.g., host.com:3001 or [::1]:3001)
  let hostname = hostPart;
  let port: number | null = null;

  if (hostPart.startsWith('[')) {
    // IPv6 host e.g. [::1]:3001
    const closingBracket = hostPart.indexOf(']');
    if (closingBracket === -1) {
      return invalidResult(raw);
    }
    hostname = hostPart.slice(0, closingBracket + 1);
    const rest = hostPart.slice(closingBracket + 1);
    if (rest.startsWith(':')) {
      const rawPort = rest.slice(1);
      const parsedPort = Number(rawPort);
      if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        return invalidResult(raw);
      }
      port = parsedPort;
    } else if (rest !== '') {
      return invalidResult(raw);
    }
  } else {
    // IPv4 or domain name e.g. console.sauta.app:3001
    const parts = hostPart.split(':');
    if (parts.length > 2) {
      // Invalid hostname format
      return invalidResult(raw);
    }
    hostname = parts[0] || '';
    if (parts.length === 2) {
      const rawPort = parts[1] || '';
      const parsedPort = Number(rawPort);
      if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535 || String(parsedPort) !== rawPort) {
        return invalidResult(raw);
      }
      port = parsedPort;
    }
  }

  // Strip trailing dot from hostname if present (e.g. sauta.app.)
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }

  // Reject raw host with internal whitespace, tabs, or control chars
  if (/[\s\r\n\t]/.test(raw)) {
    return invalidResult(raw);
  }

  if (!hostname || hostname.includes('/') || hostname.includes('\\') || !isValidHostname(hostname)) {
    return invalidResult(raw);
  }

  // Determine console hostname from CONSOLE_ORIGIN
  let consoleHostname: string;
  try {
    consoleHostname = new URL(config.CONSOLE_ORIGIN).hostname.toLowerCase();
  } catch {
    return invalidResult(raw);
  }

  const rootDomain = config.PLATFORM_ROOT_DOMAIN.toLowerCase();

  // Classify Host
  if (hostname === consoleHostname) {
    return {
      rawHost: raw,
      hostname,
      port,
      isValid: true,
      type: 'CONSOLE',
      slug: null,
    };
  }

  if (hostname === rootDomain) {
    return {
      rawHost: raw,
      hostname,
      port,
      isValid: true,
      type: 'PLATFORM_ROOT',
      slug: null,
    };
  }

  const dotRoot = '.' + rootDomain;
  if (hostname.endsWith(dotRoot)) {
    const slugPart = hostname.slice(0, hostname.length - dotRoot.length);
    // Subdomain must be single-level slug (e.g., 'venue' in 'venue.sauta.app', not 'a.b.sauta.app')
    if (slugPart && !slugPart.includes('.') && DNS_LABEL.test(slugPart)) {
      return {
        rawHost: raw,
        hostname,
        port,
        isValid: true,
        type: 'PLATFORM_SUBDOMAIN',
        slug: slugPart,
      };
    }
  }

  // Otherwise treat as potentially custom domain or unknown
  return {
    rawHost: raw,
    hostname,
    port,
    isValid: true,
    type: 'CUSTOM',
    slug: null,
  };
}
