# Summary Disclosure Gateway

A backend gateway that puts an explicit **source gate** in front of a reading
product. Four content kinds are kept strictly apart so second-hand material can
never be published wearing the clothes of the original:

| kind | meaning | required extras |
| --- | --- | --- |
| `SOURCE_EXCERPT` | original excerpt | `version`, `pageStart`, `pageEnd` (server hashes it) |
| `READER_NOTE` | reader's note | — |
| `EDITOR_SUMMARY` | editor's summary | — |
| `AI_SUMMARY` | AI-generated summary | `modelProvider`, `modelName`, `generatedAt`, `inputBlockIds`, per-claim `citations` |

The gateway **computes citation coverage itself** and never trusts a
client-supplied value. Publishing is gated by a versioned policy, and every
successful publish freezes an **immutable snapshot** that later source edits can
never rewrite.

## Stack

Node.js 22 · TypeScript · Fastify 4 · Prisma 5 · SQLite. No real models are
called and nothing is fetched from the network.

## Quick start

```bash
npm ci        # install deps (regenerates the Prisma client via postinstall)
npm run build # prisma generate + tsc -> dist/
npm test      # migrate a throwaway DB per test + run the suite
npm start     # prisma migrate deploy + node dist/server.js
```

`DATABASE_URL` defaults to `prisma/dev.db` (see `.env`). Optional: `HOST`,
`PORT` (default 3000), `LOG_LEVEL`.

Once running:

- `GET /healthz` — liveness
- `GET /v1/openapi.json` — the OpenAPI 3.1 contract
- `GET /docs` — Swagger UI
- `npm run seed` — load a small synthetic corpus and one publication

## Coverage: the number that matters

For an `AI_SUMMARY`, `coveragePermille` is:

> deduplicated **non-whitespace** output code points covered by **at least one
> valid citation**, divided by total non-whitespace output code points,
> expressed in **per mille** and **floored**.

Details that the implementation gets right:

- **Unicode code points**, not UTF-16 units — an emoji or astral CJK character
  counts as one position (`src/lib/coverage.ts`).
- **Overlapping citations are deduplicated** by painting a per-position bitmap,
  so double-citing the same characters cannot inflate the score.
- **Whitespace is excluded** from both numerator and denominator.
- A citation is **valid only if its pinned `sourceContentHash` still equals the
  source block's live hash**. Revising a source silently invalidates stale
  citations, dropping them out of coverage.

Coverage is always recomputed on read and at publish time; the stored column is
never trusted.

## Publishing & policy v1

`POST /v1/publications` takes `policyVersion`, `expectedRevision` (optimistic
concurrency per `scope`) and `submissionIds`.

Policy **v1** rejects the publish (`422 POLICY_VIOLATION`, with machine-readable
`reasons`) unless, for every `AI_SUMMARY` involved:

- `coveragePermille >= 700`, and
- every citation hash still matches its source block.

On success the response is a `Publication` carrying an immutable `snapshot`: a
self-contained copy of every published submission plus the policy verdict.
Because it is a frozen copy, **later source revisions never alter published
history**. Revisions are unique and monotonic per scope; concurrent publishes to
the same scope serialize so exactly one wins each revision (the rest get
`409 REVISION_CONFLICT`).

## Cross-cutting behavior

- **Idempotency** — every creation endpoint accepts an `Idempotency-Key` header.
  Replaying the same key + payload returns the stored response
  (`Idempotency-Replayed: true`); reusing a key with a different payload is a
  `409 IDEMPOTENCY_KEY_REUSE`. The key is reserved before any side effect, so
  concurrent identical requests execute exactly once.
- **Pagination** — list endpoints use opaque cursors and a stable
  `(createdAt, id)` sort, so pages never skip or duplicate rows.
- **Errors** — every failure is `{ "error": { "code", "message", ...details } }`.

## Project layout

```
prisma/
  schema.prisma            # models + indexes
  migrations/              # committed SQL migration(s)
src/
  app.ts                   # Fastify app, error envelope, swagger wiring
  server.ts                # process entrypoint
  config.ts  db.ts
  openapi.ts               # hand-authored OpenAPI 3.1 document
  lib/
    coverage.ts            # Unicode-aware coverage math
    hash.ts                # canonical SHA-256 of source excerpts
    validation.ts          # per-kind request validation
    serialize.ts           # live coverage/validity evaluation + serialization
    policy.ts              # policy v1
    snapshot.ts            # immutable publication snapshots
    idempotency.ts         # exactly-once creation
    cursor.ts              # keyset pagination
    concurrency.ts         # SQLite busy-retry
    errors.ts              # AppError + helpers
  routes/
    submissions.ts
    publications.ts
scripts/seed.ts            # synthetic data (no network, no real models)
test/                      # node:test suites
```

## Tests

Run with the built-in Node test runner (`node --import tsx --test`). Each API
test gets its own migrated SQLite file for isolation. Coverage includes:

- **Unicode** — code-point counting, emoji/astral/combining-mark coverage.
- **Overlapping citations** — union semantics, no double counting.
- **Hash invalidation** — revising a source collapses coverage and blocks the
  publish with `SOURCE_HASH_MISMATCH`.
- **Concurrent publishing** — exactly one publish wins a revision; idempotent
  concurrent publishes collapse to one row.
- **Immutable history** — snapshots keep their original source content and
  coverage verdict after the source is later mutated.
