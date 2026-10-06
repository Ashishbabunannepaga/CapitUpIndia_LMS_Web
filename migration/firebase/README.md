# Firebase to Supabase migration

One-time move of the Android app's Firebase Realtime Database (`/leads`, `/events`,
`/users`) into the web app's Supabase database. Business rules come from
`/mnt/project-files/spec/parity-spec.md` §3 and §12.

## What carries over

| Old app | Web app |
| --- | --- |
| `/leads` | `leads`, in creation order. Statuses Pending and Contacted become Follow-up, Converted becomes Closed Won. Explicit designations such as Director are kept; blank ones become `poc`. |
| Note lines `[Agent - dd MMM yyyy, HH:mm]: text` | `lead_notes`, with the original author and time (read as IST), marked as already read so they do not light up the unread badge. Other note text stays in `leads.notes`. |
| `assignedAgent` names | `assigned_agent_id`: the web account with the same full name (or the email given in `agents.json`). The original creation time is kept as the assignment time, so My Day does not show old leads as new assignments. |
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

Do steps 1 to 4 ahead of time with any recent export, then steps 5 to 9 on the
day you switch, in one sitting.

### Ahead of time

1. **Export** the data: Firebase console > Realtime Database > Data > the ⋮ menu >
   Export JSON. Save it under `migration/firebase/input/` (git-ignored).
2. **Dry run**:

   ```bash
   npm run migrate:firebase -- --input migration/firebase/input/export.json
   ```

   Writes to `migration/firebase/out/`: `report.md` (what would be imported, flagged
   and skipped), `report.json`, `check.sql`, `import.sql` and `undo.sql`. It never
   connects to Firebase or Supabase.
3. **Create the agent accounts** listed in the report (Supabase dashboard >
   Authentication > Users > Add user). Each old agent is matched to the account
   whose full name is the same, ignoring case and extra spaces. A new account's
   name defaults to the part of its email before the @, so `sravani@...` already
   matches `Sravani`. Otherwise set the name in the SQL editor:

   ```sql
   update public.profiles set full_name = 'Sravani' where email = 'sravani.k@capitupindia.com';
   ```

   The old app's built-in Admin login maps to the web account named Admin if it is
   an admin, otherwise to the only active admin account. An agent account called
   Admin never takes it.

   Or map names in an `agents.json` (see `agents.example.json`: an email, or `null`
   to import an agent's leads as Unassigned) and re-run step 2 with
   `--agents migration/firebase/input/agents.json`. With more than one admin
   account, map Admin there: `{"Admin": "you@capitupindia.com"}`.
4. **Check** by running `check.sql` (read-only) in the Supabase SQL editor or psql.
   Every row should say `ok`, and each agent's "maps to" email should be that
   person. Fix anything else now, while the old app is still in use.

### On the day

5. **Freeze the old app.** Tell the team to stop using it, then lock the Firebase
   database (Realtime Database > Rules: `".write": false`) so nothing changes
   after the final export.
6. **Final export and dry run**: repeat steps 1, 2 and 4 with a fresh export. Read
   the new report; it should only differ from the earlier one by that day's work.
7. **Import** as the database owner. It is one transaction: it refuses to run
   before every agent who owns leads has an account, and refuses to run twice.
   Paste `import.sql` into the Supabase SQL editor and run it, or use psql with the
   Session pooler connection string:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration/firebase/out/import.sql
   ```

   It locks the leads table for the few seconds it takes, so run it before the
   team starts on the web app. The last result shows what was imported.
8. **Check and tidy up**: run `check.sql` again (Import status says "already
   imported"), sign in as the admin, and resolve the Duplicates page before agents
   sign in, so they do not see duplicate warnings on their own leads.
9. **Afterwards**: delete every copy of the export (it holds every user's password
   in plain text) and ask anyone who reused an old app password elsewhere to change
   it. Keep Firebase locked for a while as a read-only record, then delete it.

### Undo

If something looks wrong straight after the import, `undo.sql` (run like
`import.sql`) deletes exactly the leads and calendar events the import created,
with their notes and reminders, and removes the import marker, so a corrected
`import.sql` can run again. It refuses once anyone has edited an imported lead or
added a note or event, because that work would be lost.

## Tests

- `npm run migrate:firebase:test` runs the mapping unit tests and loads the sample
  export (`fixtures/sample-export.json`) into a throwaway Postgres with the real
  migrations, then checks statuses, agent matching (by name, email, ambiguous and
  missing accounts, the Admin login), assignment times, notes, duplicates, reminders,
  `check.sql`, that a failed or second run writes nothing, that `undo.sql` removes
  exactly the import, and that crafted text in the export stays data. Needs the same
  Postgres binaries as `npm run db:test`, or `DATABASE_URL` pointing at an empty
  database.
