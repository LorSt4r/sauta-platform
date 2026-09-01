export interface VenueAcubeCredentials {
  acubeApiKey?: string | null;
  acubeOrganizationId?: string | null;
}

export interface CheckoutSessionReceiptData {
  id?: string;
  totalAmount: number;
}

export interface TicketReceiptData {
  productName: string;
  price: number;
  vatRate: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export const tokenCache = new Map<string, CachedToken>();

/** [FIX A] Opzioni per chiamata: il mock è vietato in produzione. */
export interface AcubeRequestOptions {
  isProduction?: boolean;
}

export interface ResolvedConfig {
  isMock: boolean;
  isStatic: boolean;
  email?: string;
  password?: string;
  staticToken?: string;
  loginUrl: string;
  apiUrl: string;
  orgId: string;
}

/**
 * Parses and resolves the credentials format to determine endpoints and credentials.
 */
export function resolveAcubeConfig(
  apiKey: string,
  orgId: string,
  isProduction = false
): ResolvedConfig {
  if (apiKey === 'acube_key_test_123') {
    // [FIX A] Il bypass mock non deve MAI emettere "scontrini" finti in prod:
    // una venue misconfigurata/seedata violerebbe la compliance D.M. 07/12/2016.
    if (isProduction) {
      throw new Error(
        '[A-Cube] Chiave mock (acube_key_test_123) vietata in produzione. ' +
        'Configurare credenziali A-Cube reali per questa venue.'
      );
    }
    return {
      isMock: true,
      isStatic: false,
      loginUrl: '',
      apiUrl: '',
      orgId
    };
  }

  if (!apiKey.includes(':')) {
    // Static token
    const isSandbox = !orgId.startsWith('prod_') && !orgId.startsWith('org_prod_');
    return {
      isMock: false,
      isStatic: true,
      staticToken: apiKey,
      loginUrl: isSandbox ? 'https://common-sandbox.api.acubeapi.com/login' : 'https://common.api.acubeapi.com/login',
      apiUrl: isSandbox ? 'https://api-sandbox.acubeapi.com' : 'https://api.acubeapi.com',
      orgId
    };
  }

  const parts = apiKey.split(':');
  let env = 'sandbox';
  let email = '';
  let password = '';

  if (parts.length === 3) {
    env = parts[0] ?? 'sandbox';
    email = parts[1] ?? '';
    password = parts[2] ?? '';
  } else if (parts.length === 2) {
    email = parts[0] ?? '';
    password = parts[1] ?? '';
  } else {
    email = parts[0] ?? '';
    password = parts.slice(1).join(':');
  }

  const isSandbox = env === 'sandbox';

  return {
    isMock: false,
    isStatic: false,
    email,
    password,
    loginUrl: isSandbox ? 'https://common-sandbox.api.acubeapi.com/login' : 'https://common.api.acubeapi.com/login',
    apiUrl: isSandbox ? 'https://api-sandbox.acubeapi.com' : 'https://api.acubeapi.com',
    orgId
  };
}

/**
 * Retrieves a valid token either from memory cache or by calling the A-Cube login API.
 */
export async function getAcubeToken(
  apiKey: string,
  orgId: string,
  opts: AcubeRequestOptions = {}
): Promise<{ token: string; apiUrl: string; isMock: boolean }> {
  const resolved = resolveAcubeConfig(apiKey, orgId, opts.isProduction ?? false);

  if (resolved.isMock) {
    return { token: 'mock_token', apiUrl: '', isMock: true };
  }

  if (resolved.isStatic) {
    return { token: resolved.staticToken!, apiUrl: resolved.apiUrl, isMock: false };
  }

  const cacheKey = `${resolved.email}:${resolved.password}:${resolved.loginUrl}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
    return { token: cached.token, apiUrl: resolved.apiUrl, isMock: false };
  }

  const response = await fetch(resolved.loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      email: resolved.email,
      password: resolved.password,
      environment: resolved.loginUrl.includes('sandbox') ? 'sandbox' : 'production'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`A-Cube login failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const token = data.token;
  if (!token) {
    throw new Error('A-Cube login response did not contain token');
  }

  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000
  });

  return { token, apiUrl: resolved.apiUrl, isMock: false };
}

/**
 * Creates a fiscal receipt on A-Cube API.
 */
export async function createAcubeReceipt(
  venue: VenueAcubeCredentials,
  session: CheckoutSessionReceiptData,
  tickets: TicketReceiptData[],
  opts: AcubeRequestOptions = {}
): Promise<{ id: string; pdfUrl: string }> {
  const apiKey = venue.acubeApiKey;
  const orgId = venue.acubeOrganizationId || 'dummy';

  if (!apiKey) {
    throw new Error('A-Cube API Key is missing for this venue');
  }

  const { token, apiUrl, isMock } = await getAcubeToken(apiKey, orgId, opts);

  if (isMock) {
    return {
      id: 'rec_sandbox_mock_999',
      pdfUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
    };
  }

  const itemsMap = new Map<string, { description: string; unit_price: number; vat_rate_code: string; quantity: number }>();
  for (const ticket of tickets) {
    const key = `${ticket.productName}-${ticket.price}-${ticket.vatRate}`;
    const existing = itemsMap.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      itemsMap.set(key, {
        description: ticket.productName,
        unit_price: ticket.price / 100, // convert cents to euros
        vat_rate_code: String(ticket.vatRate),
        quantity: 1,
      });
    }
  }

  const items = Array.from(itemsMap.values());

  const payload = {
    fiscal_id: orgId,
    electronic_payment_amount: session.totalAmount / 100, // convert cents to euros
    items,
  };

  const response = await fetch(`${apiUrl}/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(orgId && orgId !== 'dummy' ? { 'X-Organization-Id': orgId } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`A-Cube create receipt failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const id = data.uuid || data.id || data.receiptId;
  const pdfUrl = session.id ? `/api/receipt/pdf/${session.id}` : `/api/receipt/pdf/${id}`;

  return { id, pdfUrl };
}

/**
 * Voids a fiscal receipt on A-Cube API.
 */
export async function voidAcubeReceipt(
  venue: VenueAcubeCredentials,
  receiptId: string,
  reason: string,
  opts: AcubeRequestOptions = {}
): Promise<any> {
  const apiKey = venue.acubeApiKey;
  const orgId = venue.acubeOrganizationId || 'dummy';

  if (!apiKey) {
    throw new Error('A-Cube API Key is missing for this venue');
  }

  const { token, apiUrl, isMock } = await getAcubeToken(apiKey, orgId, opts);

  if (isMock) {
    return { status: 'voided' };
  }

  const id = receiptId.includes('/') ? receiptId.split('/').pop()?.replace('.pdf', '') : receiptId;

  const response = await fetch(`${apiUrl}/receipts/${id}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(orgId && orgId !== 'dummy' ? { 'X-Organization-Id': orgId } : {}),
    },
  });

  if (!response.ok && response.status !== 204) {
    const errorText = await response.text();
    throw new Error(`A-Cube void receipt failed: ${response.status} - ${errorText}`);
  }

  return { status: 'voided' };
}
