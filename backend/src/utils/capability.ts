import { randomBytes, createHash } from 'crypto';
import type { PrismaClient, Prisma } from '@prisma/client';

export const CAPABILITY_PREFIX = 'swc_';

/**
 * Genera un nuovo token di capability per il wallet anonimo.
 * Formato: swc_<64 caratteri hex casuali> (32 byte).
 * Restituito una sola volta al client durante il checkout.
 */
export function generateWalletToken(): string {
  const randomHex = randomBytes(32).toString('hex');
  return `${CAPABILITY_PREFIX}${randomHex}`;
}

/**
 * Calcola l'hash SHA-256 del token di capability per il salvataggio o il confronto sul DB.
 */
export function hashWalletToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Valida che il token sia formalmente ben formato.
 */
export function isValidTokenFormat(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  return /^swc_[a-f0-9]{64}$/.test(token);
}

/**
 * Verifica sul DB se il token fornito autorizza l'accesso alla sessione specificata.
 * Ritorna true se esiste una WalletCapability non revocata per quel (sessionId, tokenHash).
 */
export async function verifyWalletCapability(
  prisma: PrismaClient | Prisma.TransactionClient,
  sessionId: string,
  token: string
): Promise<boolean> {
  if (!sessionId || typeof sessionId !== 'string' || !isValidTokenFormat(token)) {
    return false;
  }

  const tokenHash = hashWalletToken(token);
  const capability = await prisma.walletCapability.findFirst({
    where: {
      sessionId,
      tokenHash,
      revokedAt: null,
    },
    select: { id: true },
  });

  return capability !== null;
}
