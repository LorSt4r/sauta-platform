import { PrismaClient } from '@prisma/client';

/**
 * Factory per creare un PrismaClient con URL esplicito.
 * Permette ai test di passare un DATABASE_URL del container di test.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
}

let globalPrismaInstance: PrismaClient | null = null;
export const prisma = new Proxy({} as PrismaClient, {
  get(_, prop) {
    if (!globalPrismaInstance) {
      globalPrismaInstance = new PrismaClient();
    }
    const val = Reflect.get(globalPrismaInstance, prop);
    if (typeof val === 'function') {
      return val.bind(globalPrismaInstance);
    }
    return val;
  }
});
