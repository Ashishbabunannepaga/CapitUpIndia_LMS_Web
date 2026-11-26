# Backups outside Cloudflare

D1 Time Travel can restore the database to any minute in the last 30 days, but
only inside the same Cloudflare account. `.github/workflows/d1-backup.yml`
also copies the whole database to AWS S3 every night at 02:30 IST and keeps
each copy for 90 days.

Each run:

1. exports the live D1 database through Cloudflare's export API
   (`scripts/d1-backup.mjs`; the dump includes the company-name search table);
2. restores the dump into a scratch SQLite file and counts leads, events and
   notes, so an empty or broken dump fails the run (GitHub emails the owner);
3. uploads `d1/<year>/<month>/capitup-lms-prod-<time>.sql.gz` and its SHA-256
   to the bucket.

## One-time setup

1. **AWS** (CloudFormation > Create stack > Upload `infra/aws/d1-backup.yaml`,
   region ap-south-1, stack name `capitup-lms-d1-backup`). It creates:
   - a private, encrypted, versioned bucket `capitup-lms-d1-backups-<account id>`
     whose `d1/` files expire after 90 days;
   - the GitHub sign-in (OpenID Connect) provider, if the account has none
     (set `CreateOidcProvider` to `false` if it already exists);
   - the role `capitup-lms-d1-backup`, which only GitHub Actions runs on `main`
     of this repository can use, and which can only add files under `d1/`.
     No AWS keys are stored anywhere. GitHub's sign-in subject now carries
     numeric ids (`repo:owner@id/name@id:ref:...`); the stack's
     `GitHubOwnerId` and `GitHubRepositoryId` parameters cover that form.
2. **Cloudflare API token** (My Profile > API Tokens > Create token > Custom):
   Account > D1 > Edit, Account > Workers Scripts > Edit (the same token deploys,
   see docs/deploy.md). Copy it once.
3. **GitHub** (repository Settings > Secrets and variables > Actions):
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (Workers & Pages >
     Overview, right-hand side).
   - Variables: `AWS_BACKUP_ROLE_ARN` and `BACKUP_BUCKET` from the stack's
     Outputs tab; `AWS_REGION` only if not ap-south-1.
4. Actions > Nightly D1 backup > Run workflow, and check the run summary shows
   the lead count.

## Restoring

The dump is a SQLite script. To look at it or pull rows out:

```sh
aws s3 cp s3://<bucket>/d1/2026/11/capitup-lms-prod-<time>.sql.gz .
gunzip capitup-lms-prod-<time>.sql.gz
sqlite3 restored.db < capitup-lms-prod-<time>.sql
sqlite3 restored.db "select id, client_name from leads limit 5"
```

To load it into a new D1 database, drop the full-text search table from the
restored copy, export it without that table, import it, then recreate the
search table and triggers from `migrations/0001_search_triggers_seed.sql`:

```sh
sqlite3 restored.db "drop table leads_name_fts"
sqlite3 restored.db .dump > for-d1.sql
npx wrangler d1 create capitup-lms-restore --location apac
npx wrangler d1 execute capitup-lms-restore --remote --file for-d1.sql
```

For anything inside the last 30 days, D1 Time Travel is faster:
`npx wrangler d1 time-travel restore capitup-lms-prod --timestamp <ISO time>`.
