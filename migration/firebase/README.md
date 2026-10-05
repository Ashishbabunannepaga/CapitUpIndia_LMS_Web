# Firebase to Supabase migration

One-time move of the Android app's Firebase Realtime Database (`/leads`, `/events`,
`/users`) into the web app's Supabase database. Business rules come from
`/mnt/project-files/spec/parity-spec.md` §3 and §12.

## What carries over

| Old app | Web app |
| --- | --- |
| `/leads` | `leads`, in creation order. Statuses Pending and Contacted become Follow-up, Converted becomes Closed Won. Explicit designations such as Director are kept; blank ones become `poc`. |
| Note lines `[Agent - dd MMM yyyy, HH:mm]: text` | `lead_notes`, with the original author and time (read as IST). Other note text stays in `leads.notes`. |
| `assignedAgent` names | `assigned_agent_id`, through `agents.json` (name to login email). Unmapped names import as Unassigned and are flagged. |
| Renewal reminders in `/events` | Not copied. The database regenerates the due event and T-30 days to T-5 minutes reminders from each renewal date. |
| Hand-made events in `/events` | `events`, linked to the imported lead. |
| `/users` | Only the user names are read, to list agents. The values are plaintext passwords: they are never read into the output or migrated. Agents get new Supabase Auth accounts. |
| Visiting card images | Not in Firebase (the app kept them on the phone). |

Nothing is silently dropped. Values that do not fit the new schema (several phone
numbers in one field, an invalid email, an unreadable date, an unknown product) are
moved into the lead's notes and listed in the report. Duplicate companies are
imported and flagged by the database, so an admin resolves them on the Duplicates
page instead of the import guessing. Leads with no client name, and records that
repeat another one field for field, are skipped and listed.

## Steps

1. **Export** the data: Firebase console > Realtime Database > Data > the ⋮ menu >
   Export JSON. Save it under `migration/firebase/input/` (git-ignored).
2. **Map agents**: copy `agents.example.json` to `migration/firebase/input/agents.json`
   and map each old agent name to the email of their web account.
3. **Dry run**:

   ```bash
   npm run migrate:firebase -- --input migration/firebase/input/export.json \
     --agents migration/firebase/input/agents.json
   ```

   Writes `migration/firebase/out/report.md` (what would be imported, flagged and
   skipped), `report.json`, and `import.sql`. It never connects to Firebase or
   Supabase. Re-run it after editing `agents.json` until the report looks right.
4. **Create the agent accounts** listed in the report (Supabase dashboard >
   Authentication > Users > Invite, with `full_name` in the metadata).
5. **Import** as the database owner. It is one transaction: it refuses to run
   before every mapped agent has an account, and refuses to run a second time.

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration/firebase/out/import.sql
   ```

6. **Afterwards**: delete the export file (it holds every user's password in plain
   text), lock the Firebase database rules, and resolve duplicates in the web app.

## Tests

- `npm run migrate:firebase:test` runs the mapping unit tests and loads the sample
  export (`fixtures/sample-export.json`) into a throwaway Postgres with the real
  migrations, then checks statuses, agents, notes, duplicates, reminders and that a
  second run is refused. Needs the same Postgres binaries as `npm run db:test`, or
  `DATABASE_URL` pointing at an empty database.
