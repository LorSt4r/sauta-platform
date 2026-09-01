import { describe, it, expect, vi } from 'vitest';
import { computeAuditHmac, logAuthAuditEvent } from '../../src/utils/auditLogger';

describe('AuthAuditEvent Logger & HMAC Domain Separation', () => {
  const secret = 'super-secret-audit-hmac-key-32-chars-long';

  it('1. calcola HMAC con separazione di dominio per sessionId', () => {
    const hash1 = computeAuditHmac('sess_123', secret, 'session');
    const hash2 = computeAuditHmac('sess_123', secret, 'session');
    expect(hash1).toHaveLength(32);
    expect(hash1).toBe(hash2);
  });

  it('2. un dominio differente produce un HMAC totalmente diverso per lo stesso valore', () => {
    const hashSession = computeAuditHmac('val_123', secret, 'session');
    const hashOrigin = computeAuditHmac('val_123', secret, 'origin');
    expect(hashSession).not.toBe(hashOrigin);
  });

  it('3. restituisce stringa vuota per input nullo o vuoto', () => {
    expect(computeAuditHmac('', secret, 'session')).toBe('');
  });

  it('4. propaga gli errori di persistenza per consentire il rollback chiamante', async () => {
    const persistenceError = new Error('audit persistence failed');
    const prismaOrTx = {
      authAuditEvent: {
        create: vi.fn().mockRejectedValue(persistenceError),
      },
    };

    await expect(
      logAuthAuditEvent(prismaOrTx, secret, {
        requestId: 'req_audit_failure',
        action: 'user:linked',
        outcome: 'SUCCESS',
        reasonCode: 'invited_user_linked',
        channel: 'USER',
      })
    ).rejects.toBe(persistenceError);
  });

  it('5. persiste soltanto impronte HMAC, mai IP o user-agent raw', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'audit_1' });
    const prismaOrTx = { authAuditEvent: { create } };

    await logAuthAuditEvent(prismaOrTx, secret, {
      requestId: 'req_origin',
      action: 'user:login',
      outcome: 'SUCCESS',
      reasonCode: 'login_successful',
      channel: 'USER',
      originInfo: {
        ip: '203.0.113.10',
        userAgent: 'Synthetic Browser/1.0',
      },
    });

    const persisted = create.mock.calls[0][0].data;
    expect(persisted.originFingerprint).toHaveLength(32);
    expect(JSON.stringify(persisted)).not.toContain('203.0.113.10');
    expect(JSON.stringify(persisted)).not.toContain('Synthetic Browser/1.0');
  });
});
