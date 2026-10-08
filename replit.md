# INFINITE STREAMS

A Stremio HTTP add-on that exposes movie, series, and anime catalogs and streams through its API service. The `zxcstreams` provider is maintained under `artifacts/api-server/src/providers/zxcstreams`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build and run the API server on port 8080
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Manifest route: `/api/manifest.json`
- Optional `FEBBOX_TOKEN` enables the ShowBox provider.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/manifest.ts` — Stremio manifest and catalog declarations.
- `artifacts/api-server/src/providers/` — provider implementations.
- `artifacts/api-server/src/routes/stremio.ts` — manifest, catalog, meta, stream, and subtitle routes.
- `artifacts/api-server/src/providers/zxcstreams/` — ZXCStreams API client, stream mapping, and proxy.

## Product

The API server serves the Stremio manifest and provider-backed catalog/stream resources. Its public install URL ends in `/api/manifest.json`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
