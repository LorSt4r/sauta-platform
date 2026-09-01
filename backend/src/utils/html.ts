/**
 * Sanitizza una stringa per l'inserimento sicuro in HTML.
 * Previene attacchi XSS quando i dati dal database vengono interpolati in template HTML.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
