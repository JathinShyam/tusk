# PRD — Notifications, digests, realtime feed

**ID prefix:** `FR-RT-*`  
**Phase:** 6 (digests + activity log), 7 (NOTIFY + feed API)  
**Master:** [PRD.md](../PRD.md)

## 1. Problem

Users need a pullable activity history and a scheduled digest. Realtime is a **hint**, not a second source of truth.

## 2. In scope

`activity_events` rows; digest documents; `GET /v1/feed`; `GET /v1/digests/latest`; `LISTEN/NOTIFY` with small payloads.

## 3. Out of scope

Email/SMS providers, mobile push (APNs/FCM), in-app WebSocket fan-out at scale, notification preference center beyond `preferences.doc.notifyDigest: boolean` (default true).

## 4. Activity event types

| `kind` | When | Payload (jsonb, small) |
|--------|------|------------------------|
| `booking_confirmed` | Booking confirmed | `{ bookingId, experienceId }` |
| `review_created` | Review created | `{ reviewId, placeId?, experienceId? }` |
| `experience_published` | Status → published | `{ experienceId }` |

No PII in NOTIFY payload (ids only).

## 5. Functional requirements

| ID | Requirement | Phase | Acceptance |
|----|-------------|-------|------------|
| FR-RT-001 | Confirm booking inserts `activity_events` same transaction | 6 | Row exists |
| FR-RT-002 | Create review inserts activity | 6 | |
| FR-RT-003 | Publish experience inserts activity | 6 | |
| FR-RT-004 | `GET /v1/feed` returns tenant-visible events (published-related); cursor on `(created_at, id)` | 7 | RLS: no other tenant |
| FR-RT-005 | Host sees booking events for their experiences; explorer sees public publish + own bookings | 7 | Document policy |
| FR-RT-006 | Daily (tenant tz in settings, default `UTC`) job writes `digests` jsonb summary | 6 | Function + test |
| FR-RT-007 | Digest body: top 5 new published experiences, 5 trending place ids, optional rec ids | 6 | Schema `_v: 1` |
| FR-RT-008 | `GET /v1/digests/latest` returns newest digest for caller or 404 | 6 | |
| FR-RT-009 | Skip digest if `preferences.doc.notifyDigest === false` | 6 | |
| FR-RT-010 | AFTER INSERT trigger NOTIFY `tusk_activity` with JSON ids | 7 | Payload < 8000 bytes |
| FR-RT-011 | Feed is correct even if NOTIFY is dropped (pull is SoT) | 7 | |

## 6. User stories

- As an explorer, I open the app and see a feed of new experiences.
- As an explorer, I fetch yesterday’s digest.
- As a developer, I subscribe to NOTIFY locally to tail events.

## 7. Realtime implementation note (product-visible)

v1 does **not** require a browser EventSource. A README snippet showing `LISTEN tusk_activity` in `psql` is enough. Optional Fastify LISTEN plugin is a demo, not a mobile-scale fan-out.

## 8. Dependencies

Phase 3–5 writes. Partitioning of `activity_events` is Phase 6 technical (TRD).
