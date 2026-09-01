const SENSITIVE_QUERY_PARAMETER = /([?&])(code|state)=[^&]*/gi;

export function sanitizeRequestUrl(url: string): string {
  return url.replace(
    SENSITIVE_QUERY_PARAMETER,
    '$1$2=[REDACTED]'
  );
}
