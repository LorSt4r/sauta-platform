import { describe, expect, it } from 'vitest';
import {
  isFingerprintAssetPath,
  parseHostAuthority,
} from '../../src/utils/hostAuthority.js';
import { getPlatformPermissions, hasPlatformPermission, hasVenuePermission } from '../../src/utils/rbac.js';
import {
  canTransitionOnboardingStatus,
  evaluateAllSteps,
  evaluateVenueReadiness,
  ReadinessFacts,
} from '../../src/services/onboardingStateMachine.js';
import {
  computeIdempotencyDedupKey,
  computeRequestHash,
  isValidIdempotencyKey,
} from '../../src/utils/idempotency.js';
import {
  computeRetryBackoffMs,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from '../../src/services/identityProvisioningService.js';

describe('Host Authority Parser (Pure Unit Tests)', () => {
  const config = {
    CONSOLE_ORIGIN: 'http://console.sauta.test:3001',
    PLATFORM_ROOT_DOMAIN: 'sauta.test',
  };

  it('parses console host correctly', () => {
    const res = parseHostAuthority('console.sauta.test:3001', config);
    expect(res.isValid).toBe(true);
    expect(res.type).toBe('CONSOLE');
    expect(res.hostname).toBe('console.sauta.test');
    expect(res.port).toBe(3001);
  });

  it('parses platform subdomain correctly', () => {
    const res = parseHostAuthority('venue1.sauta.test', config);
    expect(res.isValid).toBe(true);
    expect(res.type).toBe('PLATFORM_SUBDOMAIN');
    expect(res.hostname).toBe('venue1.sauta.test');
    expect(res.slug).toBe('venue1');
  });

  it('parses platform root domain correctly', () => {
    const res = parseHostAuthority('sauta.test', config);
    expect(res.isValid).toBe(true);
    expect(res.type).toBe('PLATFORM_ROOT');
  });

  it('rejects multi-level subdomains as valid venue slug', () => {
    const res = parseHostAuthority('a.b.sauta.test', config);
    expect(res.type).toBe('CUSTOM');
    expect(res.slug).toBeNull();
  });

  it('fails closed on missing, array or malformed host header', () => {
    expect(parseHostAuthority(undefined, config).isValid).toBe(false);
    expect(parseHostAuthority('', config).isValid).toBe(false);
    expect(parseHostAuthority(['a.com', 'b.com'], config).isValid).toBe(false);
    expect(parseHostAuthority('bad_host_with_spaces ', config).isValid).toBe(false);
    expect(parseHostAuthority('example.com:', config).isValid).toBe(false);
    expect(parseHostAuthority('example.com:01', config).isValid).toBe(false);
    expect(parseHostAuthority('a..sauta.test', config).isValid).toBe(false);
    expect(parseHostAuthority('-bad.sauta.test', config).isValid).toBe(false);
    expect(parseHostAuthority('bad-.sauta.test', config).isValid).toBe(false);
  });

  it('ignores X-Forwarded-Host and Forwarded because parser takes Host parameter', () => {
    // Parser operates strictly on the parameter passed to it
    const res = parseHostAuthority('legit-venue.sauta.test', config);
    expect(res.slug).toBe('legit-venue');
  });

  it('classifies only fingerprinted asset paths for immutable caching', () => {
    expect(isFingerprintAssetPath('/assets/console-C5VVt_Eo.js')).toBe(true);
    expect(isFingerprintAssetPath('/assets/style-n5anX0aa.css?v=1')).toBe(true);
    expect(isFingerprintAssetPath('/assets/console.js')).toBe(false);
    expect(isFingerprintAssetPath('/api/assets/console-C5VVt_Eo.js')).toBe(false);
  });
});

describe('Durable idempotency and retry policy', () => {
  it('uses domain-separated route, actor and raw key hashes', () => {
    const base = computeIdempotencyDedupKey(
      '/api/platform/venues',
      'user-1',
      'key-1'
    );
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(
      computeIdempotencyDedupKey(
        '/api/platform/venues/:venueId/activate',
        'user-1',
        'key-1'
      )
    ).not.toBe(base);
    expect(
      computeIdempotencyDedupKey('/api/platform/venues', 'user-2', 'key-1')
    ).not.toBe(base);
    expect(
      computeIdempotencyDedupKey('/api/platform/venues', 'user-1', 'key-2')
    ).not.toBe(base);
  });

  it('canonicalizes request object key order and validates raw key charset', () => {
    expect(computeRequestHash({ b: 2, a: 1 })).toBe(
      computeRequestHash({ a: 1, b: 2 })
    );
    expect(computeRequestHash({ a: 1 })).not.toBe(
      computeRequestHash({ a: 2 })
    );
    expect(isValidIdempotencyKey('safe.Key_01-test')).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('contains space')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(129))).toBe(false);
  });

  it('applies deterministic bounded exponential backoff', () => {
    expect(computeRetryBackoffMs(1)).toBe(RETRY_BACKOFF_BASE_MS);
    expect(computeRetryBackoffMs(2)).toBe(RETRY_BACKOFF_BASE_MS * 2);
    expect(computeRetryBackoffMs(100)).toBe(RETRY_BACKOFF_MAX_MS);
  });
});

describe('RBAC Platform Permissions (Wave 9C.0C)', () => {
  it('grants new platform permissions only to PLATFORM_ADMIN', () => {
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:venues:manage')).toBe(true);
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:onboarding:review')).toBe(true);
    expect(hasPlatformPermission('PLATFORM_ADMIN', 'platform:invitations:manage')).toBe(true);

    expect(hasPlatformPermission('NONE', 'platform:venues:manage')).toBe(false);
    expect(hasPlatformPermission(undefined, 'platform:venues:manage')).toBe(false);
  });

  it('does not grant platform permissions via venue permissions', () => {
    expect(hasVenuePermission('OWNER', 'venue:manage')).toBe(true);
    expect(getPlatformPermissions('NONE').size).toBe(0);
  });
});

describe('Onboarding State Machine & Readiness Evaluator', () => {
  it('enforces allowed status transitions', () => {
    expect(canTransitionOnboardingStatus('DRAFT', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionOnboardingStatus('IN_PROGRESS', 'READY_FOR_REVIEW')).toBe(true);
    expect(canTransitionOnboardingStatus('READY_FOR_REVIEW', 'ACTIVE')).toBe(true);
    expect(canTransitionOnboardingStatus('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionOnboardingStatus('SUSPENDED', 'IN_PROGRESS')).toBe(true);

    // Disallowed transitions
    expect(canTransitionOnboardingStatus('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransitionOnboardingStatus('DRAFT', 'READY_FOR_REVIEW')).toBe(false);
    expect(canTransitionOnboardingStatus('ACTIVE', 'DRAFT')).toBe(false);
  });

  it('evaluates all 7 steps correctly', () => {
    const incompleteFacts: ReadinessFacts = {
      venueId: 'v1',
      onboardingStatus: 'DRAFT',
      isActive: false,
      hasActiveOwner: false,
      hasVerifiedPlatformDomain: false,
      hasValidCatalog: false,
      legalInfoComplete: false,
      legalReviewed: false,
      operationsReviewed: false,
      stripeReady: false,
      fiscalReady: false,
      workosOrganizationMapped: false,
    };

    const steps = evaluateAllSteps(incompleteFacts);
    expect(steps.OWNER.status).toBe('IN_PROGRESS');
    expect(steps.DOMAIN.status).toBe('IN_PROGRESS');
    expect(steps.CATALOG.status).toBe('NOT_STARTED');
    expect(steps.LEGAL.status).toBe('IN_PROGRESS');
    expect(steps.OPERATIONS.status).toBe('BLOCKED');
    expect(steps.STRIPE.status).toBe('BLOCKED');
    expect(steps.FISCAL.status).toBe('BLOCKED');
  });

  it('denies activation when STRIPE or FISCAL is missing even if other steps are ready', () => {
    const almostReadyFacts: ReadinessFacts = {
      venueId: 'v1',
      onboardingStatus: 'READY_FOR_REVIEW',
      isActive: false,
      hasActiveOwner: true,
      hasVerifiedPlatformDomain: true,
      hasValidCatalog: true,
      legalInfoComplete: true,
      legalReviewed: true,
      operationsReviewed: true,
      stripeReady: false, // STRIPE NOT READY
      fiscalReady: false, // FISCAL NOT READY
      workosOrganizationMapped: true,
    };

    const readiness = evaluateVenueReadiness(almostReadyFacts);
    expect(readiness.eligible).toBe(false);
    expect(readiness.missingSteps).toContain('STRIPE');
    expect(readiness.missingSteps).toContain('FISCAL');
    expect(readiness.reasonCodes).toContain('stripe_not_ready');
    expect(readiness.reasonCodes).toContain('fiscal_not_ready');
  });

  it('allows activation only when all 7 steps are READY, workos org is mapped, and status is READY_FOR_REVIEW', () => {
    const readyFacts: ReadinessFacts = {
      venueId: 'v1',
      onboardingStatus: 'READY_FOR_REVIEW',
      isActive: false,
      hasActiveOwner: true,
      hasVerifiedPlatformDomain: true,
      hasValidCatalog: true,
      legalInfoComplete: true,
      legalReviewed: true,
      operationsReviewed: true,
      stripeReady: true,
      fiscalReady: true,
      workosOrganizationMapped: true,
    };

    const readiness = evaluateVenueReadiness(readyFacts);
    expect(readiness.eligible).toBe(true);
    expect(readiness.missingSteps).toHaveLength(0);
  });
});
