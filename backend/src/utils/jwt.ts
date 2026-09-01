import jwt, {
  type JwtPayload,
  type SignOptions,
  type VerifyOptions,
} from 'jsonwebtoken';

export interface TicketPayload {
  ticketId: string;
  venueId: string;
}

/**
 * Funzione PURA: firma un payload con un secret esplicito.
 * Testabile senza env — passa secret come argomento.
 */
export function signToken(payload: TicketPayload, secret: string, options?: SignOptions): string {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: '12h',
    ...options,
  });
}

/**
 * Funzione PURA: verifica un token con un secret esplicito.
 * Ritorna il payload se valido, null se scaduto/manomesso.
 */
export function verifyToken(
  token: string,
  secret: string,
  options?: VerifyOptions
): (TicketPayload & JwtPayload) | null {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      ...options,
    });
    if (
      typeof decoded === 'string' ||
      !('ticketId' in decoded) ||
      !('venueId' in decoded) ||
      typeof decoded.ticketId !== 'string' ||
      typeof decoded.venueId !== 'string'
    ) {
      return null;
    }
    return decoded as TicketPayload & JwtPayload;
  } catch {
    return null;
  }
}

// --- Wrapper retrocompatibili (leggono JWT_SECRET da config singleton) ---
// I moduli production usano questi; i test usano le funzioni pure sopra.

import { config } from './config';

export function generateTicketToken(payload: TicketPayload): string {
  return signToken(payload, config.JWT_SECRET);
}

export function verifyTicketToken(token: string): TicketPayload | null {
  return verifyToken(token, config.JWT_SECRET);
}
