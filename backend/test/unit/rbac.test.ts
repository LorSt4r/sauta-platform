import { describe, it, expect } from 'vitest';
import {
  hasPlatformPermission,
  hasVenuePermission,
  getPlatformPermissions,
  getVenuePermissions,
} from '../../src/utils/rbac';

describe('RBAC Central Permission Matrix (Wave 9C.0B)', () => {
  it('1. PLATFORM_ADMIN ha solo permessi platform:*', () => {
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:venues:read')).toBe(true);
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:users:manage')).toBe(true);
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:audit:read')).toBe(true);
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:support:manage')).toBe(true);

    expect(hasPlatformPermission('NONE', 'platform:venues:read')).toBe(false);
    expect(hasPlatformPermission(null, 'platform:venues:read')).toBe(false);
  });

  it('2. PLATFORM_ADMIN non ha permessi venue impliciti (deny-by-default)', () => {
    expect(hasVenuePermission(null, 'venue:read')).toBe(false);
    expect(hasVenuePermission(null, 'catalog:manage')).toBe(false);
  });

  it('3. OWNER ha tutti i permessi venue', () => {
    const ownerPerms = getVenuePermissions('OWNER');
    expect(ownerPerms.has('venue:read')).toBe(true);
    expect(ownerPerms.has('venue:manage')).toBe(true);
    expect(ownerPerms.has('members:manage')).toBe(true);
    expect(ownerPerms.has('catalog:manage')).toBe(true);
    expect(ownerPerms.has('orders:read')).toBe(true);
    expect(ownerPerms.has('refunds:manage')).toBe(true);
    expect(ownerPerms.has('fiscal:manage')).toBe(true);
    expect(ownerPerms.has('integrations:manage')).toBe(true);
    expect(ownerPerms.has('domains:manage')).toBe(true);
    expect(ownerPerms.has('tickets:read')).toBe(true);
    expect(ownerPerms.has('tickets:consume')).toBe(true);
    expect(ownerPerms.has('audit:read')).toBe(true);
  });

  it('4. MANAGER ha permessi operativi limitati (niente members, fiscal o domains)', () => {
    expect(hasVenuePermission('MANAGER', 'venue:read')).toBe(true);
    expect(hasVenuePermission('MANAGER', 'catalog:manage')).toBe(true);
    expect(hasVenuePermission('MANAGER', 'orders:read')).toBe(true);
    expect(hasVenuePermission('MANAGER', 'refunds:manage')).toBe(true);
    expect(hasVenuePermission('MANAGER', 'tickets:read')).toBe(true);
    expect(hasVenuePermission('MANAGER', 'tickets:consume')).toBe(true);

    expect(hasVenuePermission('MANAGER', 'members:manage')).toBe(false);
    expect(hasVenuePermission('MANAGER', 'fiscal:manage')).toBe(false);
    expect(hasVenuePermission('MANAGER', 'domains:manage')).toBe(false);
  });

  it('5. STAFF ha soltanto tickets:read e tickets:consume', () => {
    expect(hasVenuePermission('STAFF', 'tickets:read')).toBe(true);
    expect(hasVenuePermission('STAFF', 'tickets:consume')).toBe(true);

    expect(hasVenuePermission('STAFF', 'venue:read')).toBe(false);
    expect(hasVenuePermission('STAFF', 'catalog:manage')).toBe(false);
    expect(hasVenuePermission('STAFF', 'orders:read')).toBe(false);
    expect(hasVenuePermission('STAFF', 'refunds:manage')).toBe(false);
  });
});
