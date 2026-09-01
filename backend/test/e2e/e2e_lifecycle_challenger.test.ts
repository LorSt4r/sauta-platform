import { describe, it, expect } from 'vitest';
import { setupE2eTest, cleanupE2eTest, getBaseUrl } from './e2e-helper';

describe('Challenger 2: e2e-helper.ts Multi-Suite Lifecycle Empirical Verification', () => {
  it('initializes and cleans up E2E server repeatedly across consecutive lifecycle cycles', async () => {
    const ports: string[] = [];

    for (let cycle = 1; cycle <= 3; cycle++) {
      const setup = await setupE2eTest();
      expect(setup.app).toBeDefined();
      expect(setup.prisma).toBeDefined();
      expect(setup.baseUrl).toMatch(/^http:\/\/demo\.localhost:\d+$/);

      ports.push(setup.baseUrl);

      // Verify server socket is active and responsive to HTTP request
      const response = await fetch(`${setup.baseUrl}/health`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('status', 'ok');

      // Cleanup current lifecycle cycle
      await cleanupE2eTest();

      // Confirm getBaseUrl throws after cleanup
      expect(() => getBaseUrl()).toThrow('E2E server is not running');
    }

    // Ensure all cycles got valid baseUrls
    expect(ports.length).toBe(3);
  }, 120000);

  it('handles concurrent HTTP requests on listening E2E server without socket errors', async () => {
    const setup = await setupE2eTest();

    try {
      const requests = Array.from({ length: 10 }).map(() =>
        fetch(`${setup.baseUrl}/health`)
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
      }
    } finally {
      await cleanupE2eTest();
    }
  }, 120000);
});
