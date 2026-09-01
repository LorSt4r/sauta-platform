import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { setupE2eTest, cleanupE2eTest } from './e2e-helper';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

describe('DevOps Health & Infrastructure E2E Tests', () => {
  let app: any;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    const setup = await setupE2eTest();
    app = setup.app;
    prisma = setup.prisma;
    baseUrl = setup.baseUrl;
  });

  afterAll(async () => {
    await cleanupE2eTest();
  });

  // TIER 1: Functional Verification
  describe('Tier 1: Functional Verification', () => {
    it('should respond with 200 OK on GET /health', async () => {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      expect(response.status).toBe(200);
      const data: any = await response.json();
      expect(data.status).toBe('ok');
    });

    it('should include server uptime in GET /health response', async () => {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      const data: any = await response.json();
      expect(data.uptime).toBeDefined();
      expect(typeof data.uptime).toBe('number');
      expect(data.uptime).toBeGreaterThan(0);
    });

    it('should include database status in GET /health response', async () => {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      const data: any = await response.json();
      expect(data.database).toBeDefined();
      expect(data.database.status).toBe('ok');
    });

    it('should perform a real database query (SELECT 1) during health check', async () => {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      const data: any = await response.json();
      expect(data.database.latencyMs).toBeDefined();
      expect(data.database.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should verify the backup script backup.sh exists in the project scripts folder', async () => {
      const rootPath = path.resolve(__dirname, '../../../');
      const backupScriptPath = path.join(rootPath, 'scripts/backup.sh');
      const exists = fs.existsSync(backupScriptPath);
      expect(exists).toBe(true);
    });

    it('should verify that backup.sh script is executable', async () => {
      const rootPath = path.resolve(__dirname, '../../../');
      const backupScriptPath = path.join(rootPath, 'scripts/backup.sh');

      const stats = fs.statSync(backupScriptPath);
      // Check user executable permission bit
      const isExecutable = !!(stats.mode & fs.constants.S_IXUSR);
      expect(isExecutable).toBe(true);
    });
  });

  // TIER 2: Boundary & Error Conditions
  describe('Tier 2: Boundary & Error Conditions', () => {
    it('should return 500 when database connection is unavailable', async () => {
      const originalQueryRaw = prisma.$queryRaw.bind(prisma);
      prisma.$queryRaw = vi.fn(async () => {
        throw new Error('database unavailable');
      }) as typeof prisma.$queryRaw;
      try {
        const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
        expect(response.status).toBe(500);
        const data: any = await response.json();
        expect(data.status).toBe('error');
        expect(data.database.status).toBe('down');
      } finally {
        prisma.$queryRaw = originalQueryRaw as typeof prisma.$queryRaw;
      }
    });

    it('should reject POST requests on GET /health with 400, 404 or 405', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect([400, 404, 405]).toContain(response.status);
    });

    it('should fail with exit code 1 when running backup.sh without DATABASE_URL', async () => {
      const rootPath = path.resolve(__dirname, '../../../');
      const backupScriptPath = path.join(rootPath, 'scripts/backup.sh');
      const envWithoutDatabaseUrl = { ...process.env };
      delete envWithoutDatabaseUrl.DATABASE_URL;

      try {
        execFileSync('/bin/bash', [backupScriptPath], {
          env: envWithoutDatabaseUrl,
          stdio: 'pipe',
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.status).toBe(1);
      }
    });

    it('should fail with exit code 1 when running backup.sh with invalid database connection string', async () => {
      const rootPath = path.resolve(__dirname, '../../../');
      const backupScriptPath = path.join(rootPath, 'scripts/backup.sh');

      try {
        execFileSync('/bin/bash', [backupScriptPath], {
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://invalid_user:invalid_pwd@localhost:9999/invalid_db',
          },
          stdio: 'pipe',
        });
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.status).toBe(1);
      }
    });

    it('should not expose database passwords in GET /health error responses', async () => {
      const originalQueryRaw = prisma.$queryRaw.bind(prisma);
      prisma.$queryRaw = vi.fn(async () => {
        throw new Error('postgresql://sauta:sauta_test@database/sauta_test');
      }) as typeof prisma.$queryRaw;
      try {
        const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
        const data: any = await response.json();

        const errorString = JSON.stringify(data);
        expect(errorString).not.toContain('sauta_test');
        expect(errorString).not.toContain('postgresql://');
      } finally {
        prisma.$queryRaw = originalQueryRaw as typeof prisma.$queryRaw;
      }
    });

    it('should handle rapid concurrent health check requests without rate limiting monitoring paths', async () => {
      const requests = Array(15).fill(null).map(() =>
        fetch(`${baseUrl}/health`, { method: 'GET' })
      );
      const responses = await Promise.all(requests);
      responses.forEach((res) => {
        // Health route should have higher or bypassed rate-limiting for monitoring
        expect(res.status).toBe(200);
      });
    });
  });
});
