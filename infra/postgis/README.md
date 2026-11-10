# PostGIS development container

**Status: prepared, not installed** (decision D-009). Nothing here has been run.

| Item | Value |
|---|---|
| Image | `postgis/postgis:17-3.6`, pinned by digest `sha256:1ac10b25…cb095` (published 2026-10-26) |
| Port | `127.0.0.1:5433`. The existing Homebrew PostgreSQL 15 keeps 5432 and is never touched. |
| Data | Docker named volume `chronos-pgdata` |
| Credentials | `.env` (gitignored), copied from `.env.example` |

## At milestone 1.2

1. Install Docker Desktop (needs your approval at that time).
2. Copy `.env.example` to `.env` and set a local password.
3. Start the database:

   ```bash
   docker compose -f infra/postgis/compose.yaml up -d
   ```

4. Apply migrations cut from `db/schema.sql` (Alembic, added in 1.2).

## Apple silicon note

The official `postgis/postgis` images are published for **amd64 only**. On the M2 the container runs under Rosetta emulation, which is fine for development but slower for heavy geometry work. If milestone 1.2 shows the ingest is too slow, the fallback is a small `Dockerfile`:

- the official multi-arch `postgres:17-bookworm` image (native arm64), pinned by digest;
- the PGDG `postgresql-17-postgis-3` package, pinned by version.

Both come from official sources, so the pin is kept either way.
