import { PlatformRole, VenueRole } from '@prisma/client';

export type PlatformPermission =
  | 'platform:venues:read'
  | 'platform:venues:manage'
  | 'platform:onboarding:review'
  | 'platform:invitations:manage'
  | 'platform:users:manage'
  | 'platform:audit:read'
  | 'platform:support:manage';

export type VenuePermission =
  | 'venue:read'
  | 'venue:manage'
  | 'members:manage'
  | 'catalog:manage'
  | 'orders:read'
  | 'refunds:manage'
  | 'fiscal:manage'
  | 'integrations:manage'
  | 'domains:manage'
  | 'tickets:read'
  | 'tickets:consume'
  | 'audit:read';

export type ConsolePermission = PlatformPermission | VenuePermission;

const PLATFORM_ADMIN_PERMISSIONS: ReadonlySet<PlatformPermission> = new Set([
  'platform:venues:read',
  'platform:venues:manage',
  'platform:onboarding:review',
  'platform:invitations:manage',
  'platform:users:manage',
  'platform:audit:read',
  'platform:support:manage',
]);

const OWNER_PERMISSIONS: ReadonlySet<VenuePermission> = new Set([
  'venue:read',
  'venue:manage',
  'members:manage',
  'catalog:manage',
  'orders:read',
  'refunds:manage',
  'fiscal:manage',
  'integrations:manage',
  'domains:manage',
  'tickets:read',
  'tickets:consume',
  'audit:read',
]);

const MANAGER_PERMISSIONS: ReadonlySet<VenuePermission> = new Set([
  'venue:read',
  'catalog:manage',
  'orders:read',
  'refunds:manage',
  'tickets:read',
  'tickets:consume',
]);

const STAFF_PERMISSIONS: ReadonlySet<VenuePermission> = new Set([
  'tickets:read',
  'tickets:consume',
]);

export function getPlatformPermissions(role: PlatformRole): ReadonlySet<PlatformPermission> {
  if (role === 'PLATFORM_ADMIN') {
    return PLATFORM_ADMIN_PERMISSIONS;
  }
  return new Set();
}

export function getVenuePermissions(role: VenueRole): ReadonlySet<VenuePermission> {
  switch (role) {
    case 'OWNER':
      return OWNER_PERMISSIONS;
    case 'MANAGER':
      return MANAGER_PERMISSIONS;
    case 'STAFF':
      return STAFF_PERMISSIONS;
    default:
      return new Set();
  }
}

export function hasPlatformPermission(
  role: PlatformRole | undefined | null,
  permission: PlatformPermission
): boolean {
  if (!role || role === 'NONE') return false;
  return getPlatformPermissions(role).has(permission);
}

export function hasVenuePermission(
  role: VenueRole | undefined | null,
  permission: VenuePermission
): boolean {
  if (!role) return false;
  return getVenuePermissions(role).has(permission);
}
