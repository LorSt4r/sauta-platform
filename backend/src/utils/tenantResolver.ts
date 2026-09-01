import { PrismaClient } from '@prisma/client';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { parseHostAuthority } from './hostAuthority';
import { AppConfig } from './config';

export interface TenantContext {
  venueId: string;
  hostname: string;
  venueName: string;
}

export interface TenantResolverOptions {
  prisma: PrismaClient;
  config: AppConfig;
  isProduction?: boolean;
}

export interface TenantResolver {
  resolveTenant(rawHost?: string | null): Promise<TenantContext | null>;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext | null;
  }
  interface FastifyInstance {
    tenantGuard?: (req: FastifyRequest) => Promise<void>;
  }
}

/**
 * Factory per creare il tenant resolver con Dependency Injection.
 * Non modifica stato, non esegue side-effect provider.
 */
export function createTenantResolver(opts: TenantResolverOptions): TenantResolver {
  const { prisma, config, isProduction = false } = opts;

  return {
    async resolveTenant(rawHost?: string | null): Promise<TenantContext | null> {
      const hostAuth = parseHostAuthority(rawHost ?? undefined, config);
      if (!hostAuth.isValid || hostAuth.type === 'UNKNOWN') {
        return null;
      }
      const hostname = hostAuth.hostname;

      // In produzione, i domini .localhost (es. demo.localhost) sono tassativamente rifiutati
      if (isProduction && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
        return null;
      }

      // Gli errori DB (Prisma) non vengono catturati qui ma lasciati propagare
      // affinché l'error handler globale restituisca un 500 sanitizzato invece di mascherare il guasto come 404.
      const domain = await prisma.venueDomain.findFirst({
        where: {
          hostname,
          status: 'VERIFIED',
          venue: {
            isActive: true,
          },
        },
        select: {
          venueId: true,
          hostname: true,
          venue: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!domain || !domain.venue) {
        return null;
      }

      return {
        venueId: domain.venueId,
        hostname: domain.hostname,
        venueName: domain.venue.name,
      };
    },
  };
}

/**
 * Crea la guardia preHandler applicata ESCLUSIVAMENTE alle rotte tenant-dependent.
 */
export function createTenantGuard(resolver: TenantResolver) {
  return async function tenantGuard(req: FastifyRequest): Promise<void> {
    const rawHost = req.headers.host as string | undefined;
    req.tenant = await resolver.resolveTenant(rawHost);
  };
}

/**
 * Plugin Fastify per decorare le richieste e registrare il tenantGuard.
 * Non registra hook globali (es. onRequest o preHandler globali).
 */
export async function registerTenantResolver(
  fastify: FastifyInstance,
  resolver: TenantResolver
): Promise<void> {
  fastify.decorateRequest('tenant', null);
  fastify.decorate('tenantGuard', createTenantGuard(resolver));
}
