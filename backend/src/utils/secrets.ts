import { timingSafeEqual } from 'crypto';

/**
 * [FIX B] Confronto timing-safe per segreti condivisi (X-Admin-Secret, ecc.).
 * L'uguaglianza `===` su stringhe termina al primo carattere diverso, leakando
 * il prefisso corretto via timing attack — critico per un segreto globale che
 * protegge onboarding Stripe, dati venue e annulli fiscali.
 */
export function safeSecretEqual(
  provided: string | undefined | null,
  expected: string
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
