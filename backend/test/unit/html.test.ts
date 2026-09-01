import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/utils/html';

describe('escapeHtml', () => {
  it('escape i caratteri HTML speciali', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('escape le virgolette singole e doppie', () => {
    expect(escapeHtml('"hello" \'world\'')).toBe('&quot;hello&quot; &#39;world&#39;');
  });

  it('escape la e commerciale', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('non altera stringhe senza caratteri speciali', () => {
    expect(escapeHtml('Sauta Discoteca')).toBe('Sauta Discoteca');
  });

  it('gestisce stringhe vuote', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escape sequenze XSS complesse', () => {
    const payload = `"><img src=x onerror="alert('XSS')">`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
  });
});
