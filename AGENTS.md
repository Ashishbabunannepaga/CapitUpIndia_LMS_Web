<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project notes

- Business rules live in the database (see `supabase/migrations`); keep RLS and the guard
  triggers the source of truth for who can do what, and add a case to
  `supabase/tests/access_control.test.sql` whenever you change them (`npm run db:test`).
- Keep `src/lib/database.types.ts` in sync with migrations.
- Never import `src/lib/supabase/admin.ts` outside server code; it bypasses RLS.
