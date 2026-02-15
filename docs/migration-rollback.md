# Migration Rollback Procedure

## Overview

Each data-bearing migration has a companion `down.sql` file in its migration directory. These scripts reverse the migration's changes.

## Available Rollback Scripts

| Migration | Description | down.sql |
|-----------|-------------|----------|
| `20260212222514_add_order_book_and_health_tables` | Creates `order_book_snapshots` and `platform_health_logs` | Drops both tables and indexes |
| `20260215035740_add_platform_enum` | Converts `platform` columns from TEXT to Platform enum | Reverts enum columns to TEXT, drops enum type |

## Excluded Migration

**`20260211094744_init`** — Creates the foundational `system_metadata` table and Prisma baseline. Rolling back init means dropping the entire database, which is already handled by `prisma migrate reset`. No `down.sql` is needed.

## How to Rollback

Prisma does not natively support down migrations. To roll back manually:

```bash
# 1. Connect to the database
docker exec -it pm-arbitrage-postgres psql -U postgres -d pm_arbitrage

# 2. Run the down.sql script (rollback in reverse order)
# To rollback add_platform_enum:
\i prisma/migrations/20260215035740_add_platform_enum/down.sql

# To also rollback add_order_book_and_health_tables:
\i prisma/migrations/20260212222514_add_order_book_and_health_tables/down.sql

# 3. Remove the migration record from _prisma_migrations table
DELETE FROM _prisma_migrations WHERE migration_name = '20260215035740_add_platform_enum';
DELETE FROM _prisma_migrations WHERE migration_name = '20260212222514_add_order_book_and_health_tables';

# 4. Re-apply if needed
pnpm prisma migrate dev
```

## Testing Rollback Locally

```bash
# Apply → Rollback → Re-apply cycle
pnpm prisma migrate dev                          # Apply all migrations
psql -f prisma/migrations/20260215035740_add_platform_enum/down.sql
DELETE FROM _prisma_migrations WHERE migration_name = '20260215035740_add_platform_enum';
pnpm prisma migrate dev                          # Re-apply should succeed cleanly
```
