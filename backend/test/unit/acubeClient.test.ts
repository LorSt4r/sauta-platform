import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  resolveAcubeConfig,
  getAcubeToken,
  tokenCache,
  createAcubeReceipt,
  voidAcubeReceipt
} from '../../src/utils/acubeClient';

describe('resolveAcubeConfig', () => {
  it('identifica correttamente la modalita mock', () => {
    const config = resolveAcubeConfig('acube_key_test_123', 'org_123');
    expect(config.isMock).toBe(true);
    expect(config.isStatic).toBe(false);
  });

  it('identifica correttamente un token statico (no :)', () => {
    const config = resolveAcubeConfig('static_jwt_token_here', 'org_123');
    expect(config.isMock).toBe(false);
    expect(config.isStatic).toBe(true);
    expect(config.staticToken).toBe('static_jwt_token_here');
    expect(config.apiUrl).toBe('https://api-sandbox.acubeapi.com');
  });

  it('identifica correttamente credenziali sandbox con prefisso', () => {
    const config = resolveAcubeConfig('sandbox:mario@stud.it:Pass123', 'org_123');
    expect(config.isMock).toBe(false);
    expect(config.isStatic).toBe(false);
    expect(config.email).toBe('mario@stud.it');
    expect(config.password).toBe('Pass123');
    expect(config.loginUrl).toBe('https://common-sandbox.api.acubeapi.com/login');
    expect(config.apiUrl).toBe('https://api-sandbox.acubeapi.com');
  });

  it('identifica correttamente credenziali production con prefisso', () => {
    const config = resolveAcubeConfig('production:mario@stud.it:Pass123', 'org_123');
    expect(config.isMock).toBe(false);
    expect(config.isStatic).toBe(false);
    expect(config.email).toBe('mario@stud.it');
    expect(config.password).toBe('Pass123');
    expect(config.loginUrl).toBe('https://common.api.acubeapi.com/login');
    expect(config.apiUrl).toBe('https://api.acubeapi.com');
  });

  it('assume sandbox di default per credenziali senza prefisso ma con :', () => {
    const config = resolveAcubeConfig('mario@stud.it:Pass123', 'org_123');
    expect(config.email).toBe('mario@stud.it');
    expect(config.password).toBe('Pass123');
    expect(config.loginUrl).toBe('https://common-sandbox.api.acubeapi.com/login');
    expect(config.apiUrl).toBe('https://api-sandbox.acubeapi.com');
  });
});

describe('getAcubeToken & caching', () => {
  beforeEach(() => {
    tokenCache.clear();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('ritorna il token statico direttamente', async () => {
    const result = await getAcubeToken('my_static_token', 'org_123');
    expect(result.token).toBe('my_static_token');
    expect(result.isMock).toBe(false);
  });

  it('effettua la richiesta di login ad A-Cube in caso di credenziali nuove', async () => {
    const loginScope = nock('https://common-sandbox.api.acubeapi.com')
      .post('/login', {
        email: 'mario@stud.it',
        password: 'Pass',
        environment: 'sandbox'
      })
      .reply(200, { token: 'jwt_token_abc_123' });

    const result = await getAcubeToken('sandbox:mario@stud.it:Pass', 'org_123');
    expect(result.token).toBe('jwt_token_abc_123');
    expect(result.apiUrl).toBe('https://api-sandbox.acubeapi.com');
    expect(result.isMock).toBe(false);
    expect(loginScope.isDone()).toBe(true);
  });

  it('usa la cache in memoria e non ripete la chiamata se il token e valido', async () => {
    // 1. Primo login (chiamata di rete)
    nock('https://common-sandbox.api.acubeapi.com')
      .post('/login')
      .reply(200, { token: 'token_valore_1' });

    const first = await getAcubeToken('sandbox:mario@stud.it:Pass', 'org_123');
    expect(first.token).toBe('token_valore_1');

    // 2. Secondo login (dovrebbe leggere da cache, quindi niente nock configurato e non deve fallire)
    const second = await getAcubeToken('sandbox:mario@stud.it:Pass', 'org_123');
    expect(second.token).toBe('token_valore_1');
  });

  it('lancia un errore se il login fallisce', async () => {
    nock('https://common-sandbox.api.acubeapi.com')
      .post('/login')
      .reply(401, 'Unauthorized');

    await expect(getAcubeToken('sandbox:mario@stud.it:Pass', 'org_123')).rejects.toThrow(
      'A-Cube login failed: 401'
    );
  });
});

describe('createAcubeReceipt & voidAcubeReceipt integration with dynamic credentials', () => {
  beforeEach(() => {
    tokenCache.clear();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('emette scontrino chiamando il login e poi la sandbox receipts', async () => {
    // Mock login
    nock('https://common-sandbox.api.acubeapi.com')
      .post('/login')
      .reply(200, { token: 'jwt_receipt_token' });

    // Mock receipts
    nock('https://api-sandbox.acubeapi.com')
      .post('/receipts', {
        fiscal_id: 'org_123',
        electronic_payment_amount: 10.00,
        items: [
          { description: 'Negroni', unit_price: 10.00, vat_rate_code: '10', quantity: 1 }
        ]
      })
      .reply(201, { uuid: 'rec_123', status: 'new' });

    const venue = {
      acubeApiKey: 'sandbox:mario@stud.it:Pass',
      acubeOrganizationId: 'org_123'
    };

    const session = { id: 'sess_123', totalAmount: 1000 };
    const tickets = [{ productName: 'Negroni', price: 1000, vatRate: 10 }];

    const res = await createAcubeReceipt(venue, session, tickets);
    expect(res.id).toBe('rec_123');
    expect(res.pdfUrl).toBe('/api/receipt/pdf/sess_123');
  });

  it('storna scontrino chiamando il login e poi DELETE su uuid', async () => {
    // Mock login
    nock('https://common-sandbox.api.acubeapi.com')
      .post('/login')
      .reply(200, { token: 'jwt_void_token' });

    // Mock DELETE void
    nock('https://api-sandbox.acubeapi.com')
      .delete('/receipts/rec_123')
      .reply(204);

    const venue = {
      acubeApiKey: 'sandbox:mario@stud.it:Pass',
      acubeOrganizationId: 'org_123'
    };

    const res = await voidAcubeReceipt(venue, 'rec_123', 'storno');
    expect(res.status).toBe('voided');
  });
});

describe('[FIX A] guard produzione su chiave mock', () => {
  beforeEach(() => {
    tokenCache.clear();
    nock.cleanAll();
  });

  it('resolveAcubeConfig lancia se mock in produzione', () => {
    expect(() => resolveAcubeConfig('acube_key_test_123', 'org_123', true)).toThrow(
      /vietata in produzione/
    );
  });

  it('resolveAcubeConfig consente il mock fuori produzione (default)', () => {
    const config = resolveAcubeConfig('acube_key_test_123', 'org_123');
    expect(config.isMock).toBe(true);
  });

  it('createAcubeReceipt rifiuta il mock in produzione senza chiamate di rete', async () => {
    await expect(
      createAcubeReceipt(
        { acubeApiKey: 'acube_key_test_123', acubeOrganizationId: 'org_123' },
        { id: 'sess_1', totalAmount: 1000 },
        [{ productName: 'Negroni', price: 1000, vatRate: 10 }],
        { isProduction: true }
      )
    ).rejects.toThrow(/vietata in produzione/);
  });

  it('voidAcubeReceipt rifiuta il mock in produzione senza chiamate di rete', async () => {
    await expect(
      voidAcubeReceipt(
        { acubeApiKey: 'acube_key_test_123', acubeOrganizationId: 'org_123' },
        'rec_123',
        'storno',
        { isProduction: true }
      )
    ).rejects.toThrow(/vietata in produzione/);
  });

  it('il mock resta consentito in test/dev (emette scontrino finto)', async () => {
    const res = await createAcubeReceipt(
      { acubeApiKey: 'acube_key_test_123', acubeOrganizationId: 'org_123' },
      { id: 'sess_1', totalAmount: 1000 },
      []
    );
    expect(res.id).toBe('rec_sandbox_mock_999');
  });
});
