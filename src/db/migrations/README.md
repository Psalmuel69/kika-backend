# Database migrations

Kika's schema is managed as versioned, tracked SQL migrations, applied in
filename order and recorded in a `schema_migrations` table — see
`src/db/migrate.js` for the runner.

## Running migrations

```bash
npm run migrate
```

Safe to run repeatedly: already-applied migrations (tracked by filename
in `schema_migrations`) are skipped.

## Adding a new migration

1. Create a new file here named `NNNN_short_description.sql`, where
   `NNNN` is the next number after the highest one currently present
   (e.g. if `0004_...` is the latest, add `0005_...`). Filenames sort
   and run in plain alphabetical order, so the zero-padded number is
   what keeps them in the right sequence.
2. Write ONE focused, reviewable change per file — a new table, a new
   column, a constraint change. Don't bundle unrelated changes into one
   migration, and don't edit an already-applied migration file after the
   fact (write a new one instead, even to fix a mistake in an old one —
   once a migration has run in any environment, treat it as immutable).
3. Prefer statements that are safe to re-run if at all reasonable
   (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `DROP CONSTRAINT IF EXISTS` before re-adding one) as a defense-in-depth
   habit — the `schema_migrations` tracking table is what actually
   guarantees single-application, but idempotent SQL is what makes a
   migration safe to reason about and re-test locally without fear.
4. Test it locally against a throwaway database before committing.

## Why this exists

Before this system, the entire schema lived in one file
(`src/db/schema.sql`, now retired — see that file for a pointer here)
that grew by appending more `ALTER TABLE` statements to the bottom
whenever anything changed, and was re-run in full on every deploy. That
worked at small scale but had no way to answer "what changed in this
deploy," no explicit ordering beyond file position, and no way to know
whether a given environment was actually up to date without diffing the
whole file by eye.
