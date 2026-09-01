import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', relativePath), 'utf8');
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `marker iniziale mancante: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `marker finale mancante: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Wave 9B — static access-control audit', () => {
  const stripeRoutes = readProjectFile('backend/src/routes/stripe.ts');
  const authRoutes = readProjectFile('backend/src/routes/authRoutes.ts');
  const workosWebhookRoutes = readProjectFile(
    'backend/src/routes/workosWebhookRoutes.ts'
  );
  const loggerEntrypoint = readProjectFile('backend/src/index.ts');
  const consoleSource = readProjectFile('frontend/src/console.ts');
  const prismaSchema = readProjectFile('backend/prisma/schema.prisma');
  const walletQuery = sourceBetween(
    stripeRoutes,
    "fastify.post('/api/wallet/query'",
    "fastify.post('/api/wallet/consume-token'"
  );

  it('la query wallet usa una projection esplicita e non nomina credenziali provider', () => {
    expect(walletQuery).not.toContain('include: { venue: true');
    expect(walletQuery).not.toMatch(/\.\.\.\s*(session|venue|ticket)/);

    for (const forbiddenField of [
      'acubeApiKey',
      'acubeOrganizationId',
      'stripeAccountId',
      'pemCiphertext',
      'encryptedPem',
      'privateKeyPem',
    ]) {
      expect(walletQuery).not.toContain(forbiddenField);
    }
  });

  it('il flusso consume non conserva alias legacy qrToken', () => {
    expect(stripeRoutes).not.toContain('qrToken');
    expect(readProjectFile('frontend/src/main.ts')).not.toContain('qrToken');
  });

  it('il frontend non usa handler script inline e la CSP li blocca', () => {
    const indexHtml = readProjectFile('frontend/index.html');
    const appSource = readProjectFile('backend/src/app.ts');
    const scriptDirective = appSource.match(/scriptSrc:\s*\[([^\]]+)\]/)?.[1] ?? '';

    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
    expect(indexHtml).not.toContain('javascript:');
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(appSource).toContain(`scriptSrcAttr: ["'none'"]`);
  });

  it('la console non persiste identità o CSRF e non usa sink HTML dinamici', () => {
    expect(consoleSource).not.toContain('localStorage');
    expect(consoleSource).not.toContain('sessionStorage');
    expect(consoleSource).not.toContain('innerHTML');
    expect(consoleSource).not.toContain('outerHTML');
    expect(consoleSource).toContain('textContent');
  });

  it('webhook e audit non persistono payload provider, cookie, firma o IP raw', () => {
    const processedWorkosModel = sourceBetween(
      prismaSchema,
      'model ProcessedWorkosEvent {',
      'enum AuthAuditOutcome'
    );
    expect(processedWorkosModel).not.toMatch(
      /\b(payload|body|signature|cookie|email|ip)\b/i
    );
    expect(workosWebhookRoutes).not.toMatch(
      /authAuditEvent\.(?:create|update)[\s\S]*?(?:req\.body|rawBody|sigHeader)/
    );
    expect(authRoutes).not.toContain('remoteAddress');
  });

  it('il logger redige cookie, signature WorkOS e parametri callback', () => {
    for (const requiredRedaction of [
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.headers["workos-signature"]',
      'req.query.code',
      'req.query.state',
    ]) {
      expect(loggerEntrypoint).toContain(requiredRedaction);
    }
    expect(loggerEntrypoint).toContain('sanitizeRequestUrl');
    expect(loggerEntrypoint).not.toContain('remoteAddress');
  });
});
