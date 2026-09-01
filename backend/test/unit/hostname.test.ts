import { describe, it, expect } from 'vitest';
import { normalizeHostname, PUBLIC_HOSTNAME_ERROR } from '../../src/utils/hostname';

describe('normalizeHostname', () => {
  it('normalizza hostname validi con maiuscole, porte e trailing dot', () => {
    expect(normalizeHostname('BAR.SAUTA.APP:443')).toEqual({
      ok: true,
      hostname: 'bar.sauta.app',
    });

    expect(normalizeHostname('bar.sauta.app.')).toEqual({
      ok: true,
      hostname: 'bar.sauta.app',
    });

    expect(normalizeHostname('demo.localhost:5173')).toEqual({
      ok: true,
      hostname: 'demo.localhost',
    });

    expect(normalizeHostname('venue.sauta.app')).toEqual({
      ok: true,
      hostname: 'venue.sauta.app',
    });
  });

  it('converte IDN/Unicode in ASCII punycode', () => {
    const res = normalizeHostname('café.sauta.app');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hostname).toBe('xn--caf-dma.sauta.app');
    }
  });

  it('rifiuta URL scheme, path, query, fragment, userinfo e virgole', () => {
    expect(normalizeHostname('https://bar.sauta.app')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar.sauta.app/path')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar.sauta.app?query=1')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar.sauta.app#fragment')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('user@bar.sauta.app')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('a,b.sauta.app')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });
  });

  it('rifiuta label malformate e IP', () => {
    expect(normalizeHostname('-bar.sauta.app')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar..sauta.app')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('127.0.0.1')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('::1')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('[::1]:8080')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });
  });

  it('rifiuta porte non valide e multipli trailing dot', () => {
    expect(normalizeHostname('bar.sauta.app:999999')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar.sauta.app:abc')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });

    expect(normalizeHostname('bar.sauta.app..')).toEqual({
      ok: false,
      error: PUBLIC_HOSTNAME_ERROR,
    });
  });

  it('rifiuta stringhe vuote, null, undefined e label oltre 63 caratteri', () => {
    expect(normalizeHostname('')).toEqual({ ok: false, error: PUBLIC_HOSTNAME_ERROR });
    expect(normalizeHostname('   ')).toEqual({ ok: false, error: PUBLIC_HOSTNAME_ERROR });
    expect(normalizeHostname(null)).toEqual({ ok: false, error: PUBLIC_HOSTNAME_ERROR });
    expect(normalizeHostname(undefined)).toEqual({ ok: false, error: PUBLIC_HOSTNAME_ERROR });

    const longLabel = 'a'.repeat(64) + '.sauta.app';
    expect(normalizeHostname(longLabel)).toEqual({ ok: false, error: PUBLIC_HOSTNAME_ERROR });
  });

  it('non fa mai echo dell input grezzo malevolo nel messaggio di errore', () => {
    const maliciousInput = '<script>alert(1)</script>.bar.sauta.app';
    const res = normalizeHostname(maliciousInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(PUBLIC_HOSTNAME_ERROR);
      expect(res.error).not.toContain(maliciousInput);
      expect(res.error).not.toContain('<script>');
    }
  });
});
