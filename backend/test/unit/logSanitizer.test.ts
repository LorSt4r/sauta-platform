import { describe, expect, it } from 'vitest';
import { sanitizeRequestUrl } from '../../src/utils/logSanitizer';

describe('request log sanitization', () => {
  it('redige code e state preservando gli altri parametri', () => {
    expect(
      sanitizeRequestUrl(
        '/api/auth/callback?code=secret-code&returnTo=%2Fconsole&state=secret-state'
      )
    ).toBe(
      '/api/auth/callback?code=[REDACTED]&returnTo=%2Fconsole&state=[REDACTED]'
    );
  });

  it('redige parametri ripetuti e case-insensitive', () => {
    const sanitized = sanitizeRequestUrl(
      '/api/auth/callback?CODE=first&state=second&code=third'
    );
    expect(sanitized).not.toContain('first');
    expect(sanitized).not.toContain('second');
    expect(sanitized).not.toContain('third');
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});
