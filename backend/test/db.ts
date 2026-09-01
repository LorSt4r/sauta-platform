import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  url: string;
  stop: () => Promise<void>;
}

let current: TestDb | null = null;

/**
 * Avvia un container PostgreSQL 16 effimero per i test integration.
 * Esegue le migrazioni Prisma per creare lo schema completo.
 * Restituisce la connection string Prisma-compatible.
 *
 * Richiede Docker in esecuzione.
 */
export async function startTestDb(): Promise<TestDb> {
  if (current) return current;

  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sauta_test')
    .withUsername('sauta')
    .withPassword('sauta_test')
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgresql://sauta:sauta_test@${host}:${port}/sauta_test?schema=public`;

  // Esegui le migrazioni Prisma sul container di test
  try {
    execSync(
      `npx prisma migrate deploy --schema=prisma/schema.prisma`,
      {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
        cwd: process.cwd(),
      }
    );
  } catch (err) {
    await container.stop();
    throw new Error(`Prisma migrate deploy failed on test container: ${(err as Error).message}`);
  }

  current = {
    container,
    url,
    stop: async () => {
      if (current) {
        await current.container.stop();
        current = null;
      }
    },
  };

  return current;
}

export async function stopTestDb(): Promise<void> {
  if (current) {
    await current.stop();
  }
}

/**
 * Verifica se Docker è disponibile (per skip condizionale dei test integration).
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
