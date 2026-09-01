import { describe, it, expect } from 'vitest';
import { safeSecretEqual } from '../../src/utils/secrets';

describe('safeSecretEqual [FIX B]', () => {
  it('ritorna true per segreti identici', () => {
    expect(safeSecretEqual('super-secret-value-123', 'super-secret-value-123')).toBe(true);
  });

  it('ritorna false per segreti diversi di uguale lunghezza', () => {
    expect(safeSecretEqual('super-secret-value-123', 'super-secret-value-124')).toBe(false);
  });

  it('ritorna false per lunghezze diverse (no timing leak sulla lunghezza)', () => {
    expect(safeSecretEqual('short', 'a-much-longer-secret-value')).toBe(false);
  });

  it('ritorna false per provided undefined/null/vuoto', () => {
    expect(safeSecretEqual(undefined, 'x')).toBe(false);
    expect(safeSecretEqual(null, 'x')).toBe(false);
    expect(safeSecretEqual('', 'x')).toBe(false);
  });

  it('ritorna false per expected vuoto (config rotta non autorizza mai)', () => {
    expect(safeSecretEqual('anything', '')).toBe(false);
  });
});
