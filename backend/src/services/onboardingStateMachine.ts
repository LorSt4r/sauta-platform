/**
 * Pure Onboarding State Machine & Readiness Evaluator for Sauta.
 *
 * Rules (HANDOFF_ACTIVE.md & Prompt):
 * - Pure, deterministic logic, tested at table level.
 * - Aggregate states: DRAFT, IN_PROGRESS, READY_FOR_REVIEW, ACTIVE, SUSPENDED.
 * - 7 Steps: OWNER, LEGAL, DOMAIN, CATALOG, STRIPE, FISCAL, OPERATIONS.
 * - STRIPE and FISCAL steps do NOT accept manual override.
 * - Activation fails closed if any step is not READY.
 */

export type VenueOnboardingStatus =
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'READY_FOR_REVIEW'
  | 'ACTIVE'
  | 'SUSPENDED';

export type VenueOnboardingStepName =
  | 'OWNER'
  | 'LEGAL'
  | 'DOMAIN'
  | 'CATALOG'
  | 'STRIPE'
  | 'FISCAL'
  | 'OPERATIONS';

export type VenueOnboardingStepStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'READY';

export type VenueOnboardingStepSource =
  | 'SYSTEM'
  | 'OWNER'
  | 'PLATFORM_REVIEW'
  | 'PROVIDER'
  | 'LEGACY_BACKFILL';

export interface StepEvaluationResult {
  step: VenueOnboardingStepName;
  status: VenueOnboardingStepStatus;
  source: VenueOnboardingStepSource;
  reasonCode: string | null;
}

export interface ReadinessFacts {
  venueId: string;
  onboardingStatus: VenueOnboardingStatus;
  isActive: boolean;
  hasActiveOwner: boolean;
  hasVerifiedPlatformDomain: boolean;
  hasValidCatalog: boolean;
  legalInfoComplete: boolean;
  legalReviewed: boolean;
  operationsReviewed: boolean;
  stripeReady: boolean; // stripeChargesEnabled && stripePayoutsEnabled && stripeAccountId
  fiscalReady: boolean; // acubeOrganizationId && acubeApiKey (provider snapshot)
  workosOrganizationMapped: boolean;
}

export interface ReadinessEvaluationResult {
  eligible: boolean;
  missingSteps: VenueOnboardingStepName[];
  reasonCodes: string[];
  factsVersion: number;
}

const ALLOWED_TRANSITIONS: Record<VenueOnboardingStatus, ReadonlySet<VenueOnboardingStatus>> = {
  DRAFT: new Set(['IN_PROGRESS']),
  IN_PROGRESS: new Set(['READY_FOR_REVIEW']),
  READY_FOR_REVIEW: new Set(['IN_PROGRESS', 'ACTIVE']),
  ACTIVE: new Set(['SUSPENDED']),
  SUSPENDED: new Set(['IN_PROGRESS']),
};

export function canTransitionOnboardingStatus(
  from: VenueOnboardingStatus,
  to: VenueOnboardingStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function evaluateOwnerStep(hasActiveOwner: boolean): StepEvaluationResult {
  if (hasActiveOwner) {
    return {
      step: 'OWNER',
      status: 'READY',
      source: 'SYSTEM',
      reasonCode: null,
    };
  }
  return {
    step: 'OWNER',
    status: 'IN_PROGRESS',
    source: 'SYSTEM',
    reasonCode: 'missing_owner_membership',
  };
}

export function evaluateDomainStep(hasVerifiedPlatformDomain: boolean): StepEvaluationResult {
  if (hasVerifiedPlatformDomain) {
    return {
      step: 'DOMAIN',
      status: 'READY',
      source: 'SYSTEM',
      reasonCode: null,
    };
  }
  return {
    step: 'DOMAIN',
    status: 'IN_PROGRESS',
    source: 'SYSTEM',
    reasonCode: 'unverified_platform_domain',
  };
}

export function evaluateCatalogStep(hasValidCatalog: boolean): StepEvaluationResult {
  if (hasValidCatalog) {
    return {
      step: 'CATALOG',
      status: 'READY',
      source: 'OWNER',
      reasonCode: null,
    };
  }
  return {
    step: 'CATALOG',
    status: 'NOT_STARTED',
    source: 'OWNER',
    reasonCode: 'missing_catalog_products',
  };
}

export function evaluateLegalStep(
  legalInfoComplete: boolean,
  legalReviewed: boolean
): StepEvaluationResult {
  if (!legalInfoComplete) {
    return {
      step: 'LEGAL',
      status: 'IN_PROGRESS',
      source: 'OWNER',
      reasonCode: 'legal_info_incomplete',
    };
  }
  if (!legalReviewed) {
    return {
      step: 'LEGAL',
      status: 'BLOCKED',
      source: 'PLATFORM_REVIEW',
      reasonCode: 'legal_review_required',
    };
  }
  return {
    step: 'LEGAL',
    status: 'READY',
    source: 'PLATFORM_REVIEW',
    reasonCode: null,
  };
}

export function evaluateOperationsStep(operationsReviewed: boolean): StepEvaluationResult {
  if (operationsReviewed) {
    return {
      step: 'OPERATIONS',
      status: 'READY',
      source: 'PLATFORM_REVIEW',
      reasonCode: null,
    };
  }
  return {
    step: 'OPERATIONS',
    status: 'BLOCKED',
    source: 'PLATFORM_REVIEW',
    reasonCode: 'operations_review_required',
  };
}

export function evaluateStripeStep(stripeReady: boolean): StepEvaluationResult {
  if (stripeReady) {
    return {
      step: 'STRIPE',
      status: 'READY',
      source: 'PROVIDER',
      reasonCode: null,
    };
  }
  return {
    step: 'STRIPE',
    status: 'BLOCKED',
    source: 'PROVIDER',
    reasonCode: 'stripe_not_ready',
  };
}

export function evaluateFiscalStep(fiscalReady: boolean): StepEvaluationResult {
  if (fiscalReady) {
    return {
      step: 'FISCAL',
      status: 'READY',
      source: 'PROVIDER',
      reasonCode: null,
    };
  }
  return {
    step: 'FISCAL',
    status: 'BLOCKED',
    source: 'PROVIDER',
    reasonCode: 'fiscal_not_ready',
  };
}

export function evaluateAllSteps(facts: ReadinessFacts): Record<VenueOnboardingStepName, StepEvaluationResult> {
  return {
    OWNER: evaluateOwnerStep(facts.hasActiveOwner),
    DOMAIN: evaluateDomainStep(facts.hasVerifiedPlatformDomain),
    CATALOG: evaluateCatalogStep(facts.hasValidCatalog),
    LEGAL: evaluateLegalStep(facts.legalInfoComplete, facts.legalReviewed),
    OPERATIONS: evaluateOperationsStep(facts.operationsReviewed),
    STRIPE: evaluateStripeStep(facts.stripeReady),
    FISCAL: evaluateFiscalStep(facts.fiscalReady),
  };
}

export function evaluateVenueReadiness(facts: ReadinessFacts): ReadinessEvaluationResult {
  const steps = evaluateAllSteps(facts);
  const missingSteps: VenueOnboardingStepName[] = [];
  const reasonCodes: string[] = [];

  for (const [stepName, evalResult] of Object.entries(steps)) {
    if (evalResult.status !== 'READY') {
      missingSteps.push(stepName as VenueOnboardingStepName);
      if (evalResult.reasonCode) {
        reasonCodes.push(evalResult.reasonCode);
      }
    }
  }

  if (!facts.workosOrganizationMapped) {
    reasonCodes.push('workos_org_not_mapped');
  }

  if (facts.onboardingStatus !== 'READY_FOR_REVIEW' && facts.onboardingStatus !== 'IN_PROGRESS') {
    reasonCodes.push(`invalid_status_for_activation:${facts.onboardingStatus}`);
  }

  const eligible = missingSteps.length === 0 && facts.workosOrganizationMapped && (facts.onboardingStatus === 'READY_FOR_REVIEW');

  return {
    eligible,
    missingSteps,
    reasonCodes,
    factsVersion: 1,
  };
}
