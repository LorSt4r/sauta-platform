import { describe, it, expect } from 'vitest';
import {
  generateWalletToken,
  hashWalletToken,
  isValidTokenFormat,
  CAPABILITY_PREFIX,
} from '../../src/utils/capability';

describe('capability unit tests', () => {
  it('generates valid wallet token with swc_ prefix', () => {
    const token = generateWalletToken();
    expect(token.startsWith(CAPABILITY_PREFIX)).toBe(true);
    expect(token.length).toBe(4 + 64);
    expect(isValidTokenFormat(token)).toBe(true);
  });

  it('validates token format correctly', () => {
    const valid = generateWalletToken();
    expect(isValidTokenFormat(valid)).toBe(true);
    expect(isValidTokenFormat('invalid_token')).toBe(false);
    expect(isValidTokenFormat('swc_12345')).toBe(false);
    expect(isValidTokenFormat(`swc_${'A'.repeat(64)}`)).toBe(false);
    expect(isValidTokenFormat(` swc_${'a'.repeat(64)}`)).toBe(false);
    expect(isValidTokenFormat(12345)).toBe(false);
    expect(isValidTokenFormat(null)).toBe(false);
  });

  it('computes deterministic SHA-256 hash of raw token', () => {
    const token = generateWalletToken();
    const hash1 = hashWalletToken(token);
    const hash2 = hashWalletToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
    expect(hash1).not.toBe(token);
    expect(hashWalletToken(` ${token}`)).not.toBe(hash1);
  });
});
