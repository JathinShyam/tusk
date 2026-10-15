---
name: tusk-api
description: Implements Tusk Fastify REST /v1 routes, envelopes, errors, auth, and pagination. Use when adding endpoints, handlers, HTTP schemas, or changing API contracts.
---

# Tusk API

## Route module

`src/modules/<ctx>/<ctx>.routes.ts` registers on `/v1`. Schema for body, query, params, response.

## Envelope

```ts
{ data: T | T[], meta: { requestId: string, pagination?: { nextCursor: string | null } } }
{ error: { code: string, message: string, details?: unknown }, meta: { requestId: string } }
```

## Status cheat sheet

| Status | When |
|--------|------|
| 400 | Validation, unconstrained search, slot in past |
| 401 | Bad/missing JWT |
| 403 | Authenticated but role cannot; tenant suspended |
| 404 | Missing **or** other tenant / RLS |
| 409 | Capacity, overlap, idempotency, email taken |
| 503 | `/v1/ready` DB down |

Use TRD `error.code` strings. Stable codes; message can be human.

## Auth

- Public: health, ready, register, login, refresh.
- Else: Bearer access JWT → `sub`, `tid`, `role`.
- Switch tenant: dedicated route issues new JWT (FR-ID-007).
- Never trust `X-Tenant-Id`.

## Pagination

Opaque cursor: base64url JSON `{ t: string, id: string, score?: number }`.  
`WHERE (created_at, id) < ($t, $id)` (or score,id for search). No `OFFSET`.

## Bookings

Require `Idempotency-Key`. Persist tenant-scoped key hash + request hash + response booking id.

## Mapper

SQL returns snake_case. Mapper to camelCase at the edge. Geo: body `lat`/`lng`; storage `geog`.
