<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project notes

- The app runs on Cloudflare Workers (OpenNext) with D1 and R2; see `docs/cloudflare-d1-plan.md`.
- Business rules live in the data layer (`src/server/data/*`): every page, action and route
  calls a data function with the signed-in actor, never SQL. Add a case to the Vitest suites
  in `src/server/data/__tests__` whenever you change who can do what (`npm test`).
- Only `src/server` may import `@/server/db`; ESLint enforces it.
- After changing `src/server/db/schema.ts`, run `npm run d1:generate` and commit the migration.
