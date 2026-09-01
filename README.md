# Sauta Platform

Sauta is an independently designed, pre-production platform for venue ordering
and fulfilment. It is a portfolio project: it has not been deployed to real
venues and this repository does not claim production users or processed
payments.

The project demonstrates backend and platform engineering around tenant
isolation, identity, payments, durable workflows, auditability, and automated
verification. It is intentionally published without live credentials,
customer data, commercial planning, or deployment-specific infrastructure.

## Engineering highlights

- Hostname-derived tenant authority instead of caller-controlled tenant IDs.
- Explicit role-based access control and authorization guards.
- Idempotent webhook and onboarding flows backed by PostgreSQL constraints.
- Stripe Connect-oriented payment boundaries with signature-verified mocks in
  the automated test suite.
- Fiscal-event integrity and reconciliation primitives kept separate from
  provider side effects.
- Fastify dependency injection, explicit configuration parsing, and
  fail-closed production secrets.
- A TypeScript monorepo with 39 source files, 13 database migrations, 51 test
  files, and more than 400 automated test cases.
- CI gates for builds, unit and route tests, coverage, browser tests, schema
  validation, and clean migration deployment.

## Architecture

```text
Browser / PWA
     |
     v
Fastify API  -----> Identity provider adapter
     |  \
     |   +--------> Payment provider adapter
     |   +--------> Fiscal provider adapter
     |
     v
PostgreSQL + Prisma
  | tenant authority
  | RBAC and audit log
  | idempotency records
  | durable provider commands
  + reconciliation state
```

The authoritative tenant is resolved from a verified hostname. Routes receive
explicit dependencies, and external side effects occur outside database
transactions. Provider callbacks are authenticated and made replay-safe before
business state changes are accepted. See [the architecture notes](docs/architecture.md).

## Repository layout

```text
backend/   Fastify API, Prisma schema and automated tests
frontend/  Vite PWA and operator console
shared/    Shared security helpers and tests
scripts/   Operational utilities
```

## Run locally

Requirements:

- Node.js 22
- Docker with Compose
- PostgreSQL 16, either local or through the included Compose file

```bash
npm ci
cp backend/.env.example backend/.env
# Replace every placeholder in backend/.env with local test values.
npx prisma generate --schema=backend/prisma/schema.prisma
npm run build -w shared
npm run build -w backend
npm run build -w frontend
npm test
```

The end-to-end suite uses disposable PostgreSQL containers and mocks external
providers. No real payment, identity, or fiscal credential is required for the
test suite.

## Verification

The GitHub Actions workflow runs:

1. reproducible dependency installation;
2. Prisma client generation and schema checks;
3. shared, backend, and frontend builds;
4. unit, route, integration, and browser tests;
5. coverage gates and a clean migration deployment.

## Development approach and AI assistance

I defined the architecture, invariants, threat boundaries, acceptance
criteria, and verification strategy. AI coding agents assisted with parts of
the implementation. I reviewed and integrated changes, reproduced failures,
and accepted work only after automated checks and direct inspection. The
repository is evidence of that process; it should not be interpreted as a
claim that every line was typed manually.

## Current limitations

- No production deployment or real venue pilot has taken place.
- Payment, identity, and fiscal integrations require independent provider
  approval and production validation.
- Production infrastructure is intentionally not included in this public
  repository.
- The UI is a functional prototype; the strongest evidence in this repository
  is the backend architecture and verification suite.

## Security

Never commit `.env` files or real provider credentials. Use only test-mode
accounts during local development. Please see [SECURITY.md](SECURITY.md) before
reporting a security issue.

## License

Copyright (c) 2026 Lorenzo Vasile. The source is visible for portfolio review;
no permission to use, copy, modify, or redistribute it is granted. See
[LICENSE](LICENSE).
