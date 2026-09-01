/**
 * [FIX 3.3] Validazione stripeAccountId — funzione pura testabile.
 *
 * Formato Stripe: "acct_" + 16 caratteri alfanumerici (tipicamente 21+ char totali).
 * Esempio valido: "acct_1NqK7x2eZvKYlo2C0aBcDeFgH"
 */

/**
 * Verifica che un stripeAccountId sia nel formato corretto.
 * - Deve iniziare con "acct_"
 * - Deve essere lungo almeno 21 caratteri (acct_ + 16 alfanumerici)
 * - Dopo "acct_" deve contenere solo caratteri alfanumerici
 */
export function validateStripeAccountId(accountId: unknown): boolean {
  if (typeof accountId !== 'string') return false;
  if (!accountId.startsWith('acct_')) return false;
  if (accountId.length < 21) return false;
  const rest = accountId.slice(5);
  return /^[a-zA-Z0-9]+$/.test(rest);
}

/**
 * Estrae il prefisso "acct_" da un accountId valido.
 * Ritorna null se l'input non è valido.
 */
export function extractStripeAccountPrefix(accountId: unknown): string | null {
  if (!validateStripeAccountId(accountId)) return null;
  return (accountId as string).slice(0, 8); // "acct_" + 3 char
}
