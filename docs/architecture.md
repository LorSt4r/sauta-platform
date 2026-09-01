# Architecture and trust boundaries

## Goals

The platform is designed around four properties:

1. tenant identity cannot be selected by an untrusted query parameter;
2. external callbacks can be retried without duplicating business effects;
3. provider failures do not leave database transactions open;
4. privileged actions remain attributable through audit records.

## Request path

The request hostname is normalized and checked against authoritative venue
domains. The resulting tenant context is passed into route guards and service
functions. Callers cannot override that context with a request body or query
parameter.

Authentication establishes identity; authorization separately maps that
identity to platform and tenant roles. This distinction keeps authentication
provider concerns outside the core permission model.

## Durable provider work

Payment, identity, and fiscal providers are modeled as unreliable external
systems. The database records the intended command and an idempotency key.
Workers or route-level orchestration then perform the provider call outside the
transaction and reconcile the durable state from the result.

This avoids holding database locks during network operations and makes retry,
timeout, and partial-failure behavior explicit.

## Data integrity

The Prisma schema and migrations enforce tenant relationships, uniqueness, and
replay protection. Application-level validation recalculates security- and
money-sensitive values server-side. API responses use explicit DTOs instead of
returning complete persistence models.

## Verification strategy

- Pure utilities receive focused unit tests.
- Routes use Fastify injection with mocked provider signatures.
- PostgreSQL integration tests run against disposable containers.
- Concurrency tests exercise provisioning and fiscal sequencing.
- Browser tests cover the customer and operator flows.
- CI proves that all migrations apply cleanly to an empty database.

The public repository contains test configuration only. It does not include
live credentials, production tenant data, or operational account identifiers.
