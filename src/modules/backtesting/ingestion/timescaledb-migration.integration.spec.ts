/**
 * Integration tests for TimescaleDB migration (Story 10-95-1).
 *
 * Requires a running TimescaleDB instance. Guarded by TEST_DATABASE_URL env var.
 * Run locally: TEST_DATABASE_URL=postgresql://postgres:password@localhost:5433/pmarbitrage pnpm vitest run src/modules/backtesting/ingestion/timescaledb-migration.integration.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.runIf(DATABASE_URL)(
  'TimescaleDB Migration — historical_trades',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
      });
      await prisma.$connect();
      // Clean up any orphaned test data from interrupted runs
      await prisma.historicalTrade.deleteMany({
        where: {
          contractId: {
            startsWith: 'test-timescaledb-migration-',
          },
        },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    // --- P0: Extension verification ---

    it('[P0] TimescaleDB extension is installed', async () => {
      const result = await prisma.$queryRaw<
        { extversion: string }[]
      >`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`;

      expect(result).toHaveLength(1);
      expect(result[0].extversion).toBeDefined();
    });

    // --- P0: Hypertable verification ---

    it('[P0] historical_trades is a hypertable', async () => {
      const result = await prisma.$queryRaw<
        { hypertable_name: string }[]
      >`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'historical_trades'`;

      expect(result).toHaveLength(1);
      expect(result[0].hypertable_name).toBe('historical_trades');
    });

    it('[P0] chunk interval is 1 day', async () => {
      const result = await prisma.$queryRaw<
        { time_interval: string }[]
      >`SELECT d.time_interval::text FROM timescaledb_information.dimensions d JOIN timescaledb_information.hypertables h ON d.hypertable_name = h.hypertable_name WHERE h.hypertable_name = 'historical_trades'`;

      expect(result).toHaveLength(1);
      expect(result[0].time_interval).toBe('1 day');
    });

    // --- P0: Constraint verification ---

    it('[P0] composite PK exists: (id, timestamp)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = 'historical_trades'
        ORDER BY kcu.ordinal_position`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual(['id', 'timestamp']);
    });

    it('[P0] unique constraint includes timestamp (5 columns)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE c.relname = 'historical_trades_platform_contract_id_source_external_trad_key'
          AND i.indisunique = true
        ORDER BY array_position(i.indkey, a.attnum)`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual([
        'platform',
        'contract_id',
        'source',
        'external_trade_id',
        'timestamp',
      ]);
    });

    // --- P1: Dropped indexes ---

    it('[P1] dropped indexes no longer exist', async () => {
      const result = await prisma.$queryRaw<
        { indexname: string }[]
      >`SELECT indexname FROM pg_indexes
        WHERE tablename = 'historical_trades'
          AND indexname IN (
            'historical_trades_platform_contract_id_timestamp_idx',
            'historical_trades_timestamp_idx'
          )`;

      expect(result).toHaveLength(0);
    });

    // --- P1: CRUD operations ---

    it('[P1] createMany idempotency — ON CONFLICT DO NOTHING', async () => {
      const trade = {
        platform: 'POLYMARKET' as const,
        contractId: 'test-timescaledb-migration-001',
        source: 'PREDEXON' as const,
        externalTradeId: 'ext-trade-dedup-test',
        price: 0.55,
        size: 100,
        side: 'BUY',
        timestamp: new Date('2024-06-15T12:00:00Z'),
      };

      // Clean up any previous test data
      await prisma.historicalTrade.deleteMany({
        where: { contractId: 'test-timescaledb-migration-001' },
      });

      // First insert should succeed
      const first = await prisma.historicalTrade.createMany({
        data: [trade],
        skipDuplicates: true,
      });
      expect(first.count).toBe(1);

      // Duplicate insert should be silently skipped
      const second = await prisma.historicalTrade.createMany({
        data: [trade],
        skipDuplicates: true,
      });
      expect(second.count).toBe(0);

      // Verify only one record exists
      const count = await prisma.historicalTrade.count({
        where: { contractId: 'test-timescaledb-migration-001' },
      });
      expect(count).toBe(1);

      // Clean up
      await prisma.historicalTrade.deleteMany({
        where: { contractId: 'test-timescaledb-migration-001' },
      });
    });

    it('[P1] aggregate works on hypertable', async () => {
      const contractId = 'test-timescaledb-migration-003';

      await prisma.historicalTrade.deleteMany({ where: { contractId } });

      await prisma.historicalTrade.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'agg-test-1',
            price: 0.4,
            size: 50,
            side: 'BUY',
            timestamp: new Date('2024-07-01T10:00:00Z'),
          },
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'agg-test-2',
            price: 0.6,
            size: 150,
            side: 'SELL',
            timestamp: new Date('2024-07-02T10:00:00Z'),
          },
        ],
      });

      const result = await prisma.historicalTrade.aggregate({
        where: { contractId },
        _count: { id: true },
        _avg: { price: true },
        _sum: { size: true },
      });

      expect(result._count.id).toBe(2);
      expect(Number(result._avg.price)).toBeCloseTo(0.5, 5);
      expect(Number(result._sum.size)).toBe(200);

      await prisma.historicalTrade.deleteMany({ where: { contractId } });
    });

    it('[P1] groupBy works on hypertable', async () => {
      const contractId = 'test-timescaledb-migration-004';

      await prisma.historicalTrade.deleteMany({ where: { contractId } });

      await prisma.historicalTrade.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'grp-test-1',
            price: 0.5,
            size: 10,
            side: 'BUY',
            timestamp: new Date('2024-08-01T10:00:00Z'),
          },
          {
            platform: 'POLYMARKET',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'grp-test-2',
            price: 0.5,
            size: 20,
            side: 'SELL',
            timestamp: new Date('2024-08-02T10:00:00Z'),
          },
        ],
      });

      const result = await prisma.historicalTrade.groupBy({
        by: ['platform'],
        where: { contractId },
        _count: { id: true },
      });

      expect(result).toHaveLength(2);
      const kalshi = result.find((r) => r.platform === 'KALSHI');
      const poly = result.find((r) => r.platform === 'POLYMARKET');
      expect(kalshi?._count.id).toBe(1);
      expect(poly?._count.id).toBe(1);

      await prisma.historicalTrade.deleteMany({ where: { contractId } });
    });

    it('[P1] findMany with time range filter returns correct results', async () => {
      const contractId = 'test-timescaledb-migration-002';

      // Clean up any previous test data
      await prisma.historicalTrade.deleteMany({
        where: { contractId },
      });

      // Insert trades across different dates
      await prisma.historicalTrade.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'range-test-1',
            price: 0.6,
            size: 50,
            side: 'BUY',
            timestamp: new Date('2024-06-10T10:00:00Z'),
          },
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'range-test-2',
            price: 0.65,
            size: 75,
            side: 'SELL',
            timestamp: new Date('2024-06-15T10:00:00Z'),
          },
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            externalTradeId: 'range-test-3',
            price: 0.7,
            size: 100,
            side: 'BUY',
            timestamp: new Date('2024-06-20T10:00:00Z'),
          },
        ],
      });

      // Query with time range — should return only the middle trade
      const results = await prisma.historicalTrade.findMany({
        where: {
          contractId,
          timestamp: {
            gte: new Date('2024-06-12T00:00:00Z'),
            lte: new Date('2024-06-18T00:00:00Z'),
          },
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].externalTradeId).toBe('range-test-2');

      // Clean up
      await prisma.historicalTrade.deleteMany({
        where: { contractId },
      });
    });
  },
);

// --- Story 10-95-2: historical_prices hypertable tests ---

describe.runIf(DATABASE_URL)(
  'TimescaleDB Migration — historical_prices',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
      });
      await prisma.$connect();
      await prisma.historicalPrice.deleteMany({
        where: {
          contractId: { startsWith: 'test-timescaledb-migration-' },
        },
      });
    });

    afterAll(async () => {
      await prisma.historicalPrice.deleteMany({
        where: {
          contractId: { startsWith: 'test-timescaledb-migration-' },
        },
      });
      await prisma.$disconnect();
    });

    // --- P0: Hypertable verification ---

    it('[P0] historical_prices is a hypertable', async () => {
      const result = await prisma.$queryRaw<
        { hypertable_name: string }[]
      >`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'historical_prices'`;

      expect(result).toHaveLength(1);
      expect(result[0].hypertable_name).toBe('historical_prices');
    });

    it('[P0] chunk interval is 1 day', async () => {
      const result = await prisma.$queryRaw<
        { time_interval: string }[]
      >`SELECT d.time_interval::text FROM timescaledb_information.dimensions d JOIN timescaledb_information.hypertables h ON d.hypertable_name = h.hypertable_name WHERE h.hypertable_name = 'historical_prices'`;

      expect(result).toHaveLength(1);
      expect(result[0].time_interval).toBe('1 day');
    });

    // --- P0: Constraint verification ---

    it('[P0] composite PK exists: (id, timestamp)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = 'historical_prices'
        ORDER BY kcu.ordinal_position`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual(['id', 'timestamp']);
    });

    it('[P0] unique constraint includes timestamp (5 columns)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE c.relname = 'historical_prices_platform_contract_id_source_interval_minu_key'
          AND i.indisunique = true
        ORDER BY array_position(i.indkey, a.attnum)`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual([
        'platform',
        'contract_id',
        'source',
        'interval_minutes',
        'timestamp',
      ]);
    });

    // --- P1: Dropped indexes ---

    it('[P1] dropped indexes no longer exist', async () => {
      const result = await prisma.$queryRaw<
        { indexname: string }[]
      >`SELECT indexname FROM pg_indexes
        WHERE tablename = 'historical_prices'
          AND indexname IN (
            'historical_prices_contract_id_source_timestamp_idx',
            'historical_prices_timestamp_idx'
          )`;

      expect(result).toHaveLength(0);
    });

    // --- P1: Kept indexes ---

    it('[P1] kept indexes still exist', async () => {
      const result = await prisma.$queryRaw<
        { indexname: string }[]
      >`SELECT indexname FROM pg_indexes
        WHERE tablename = 'historical_prices'
          AND indexname IN (
            'historical_prices_platform_contract_id_timestamp_idx',
            'historical_prices_source_timestamp_idx'
          )
        ORDER BY indexname`;

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.indexname)).toEqual([
        'historical_prices_platform_contract_id_timestamp_idx',
        'historical_prices_source_timestamp_idx',
      ]);
    });

    // --- P1: CRUD operations ---

    it('[P1] createMany idempotency (skipDuplicates: true)', async () => {
      const price = {
        platform: 'KALSHI' as const,
        contractId: 'test-timescaledb-migration-p-001',
        source: 'PREDEXON' as const,
        intervalMinutes: 1,
        timestamp: new Date('2024-06-15T12:00:00Z'),
        open: 0.5,
        high: 0.55,
        low: 0.48,
        close: 0.52,
      };

      await prisma.historicalPrice.deleteMany({
        where: { contractId: price.contractId },
      });

      const first = await prisma.historicalPrice.createMany({
        data: [price],
        skipDuplicates: true,
      });
      expect(first.count).toBe(1);

      const second = await prisma.historicalPrice.createMany({
        data: [price],
        skipDuplicates: true,
      });
      expect(second.count).toBe(0);

      const count = await prisma.historicalPrice.count({
        where: { contractId: price.contractId },
      });
      expect(count).toBe(1);

      await prisma.historicalPrice.deleteMany({
        where: { contractId: price.contractId },
      });
    });

    it('[P1] findMany with time range filter', async () => {
      const contractId = 'test-timescaledb-migration-p-002';

      await prisma.historicalPrice.deleteMany({
        where: { contractId },
      });

      await prisma.historicalPrice.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            intervalMinutes: 1,
            timestamp: new Date('2024-06-10T10:00:00Z'),
            open: 0.5,
            high: 0.55,
            low: 0.48,
            close: 0.52,
          },
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            intervalMinutes: 1,
            timestamp: new Date('2024-06-15T10:00:00Z'),
            open: 0.6,
            high: 0.65,
            low: 0.58,
            close: 0.62,
          },
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            intervalMinutes: 1,
            timestamp: new Date('2024-06-20T10:00:00Z'),
            open: 0.7,
            high: 0.75,
            low: 0.68,
            close: 0.72,
          },
        ],
      });

      const results = await prisma.historicalPrice.findMany({
        where: {
          contractId,
          timestamp: {
            gte: new Date('2024-06-12T00:00:00Z'),
            lte: new Date('2024-06-18T00:00:00Z'),
          },
        },
      });

      expect(results).toHaveLength(1);
      expect(Number(results[0].close)).toBeCloseTo(0.62, 5);

      await prisma.historicalPrice.deleteMany({
        where: { contractId },
      });
    });

    it('[P1] aggregate + groupBy work on hypertable', async () => {
      const contractId = 'test-timescaledb-migration-p-003';

      await prisma.historicalPrice.deleteMany({
        where: { contractId },
      });

      await prisma.historicalPrice.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            intervalMinutes: 1,
            timestamp: new Date('2024-07-01T10:00:00Z'),
            open: 0.4,
            high: 0.45,
            low: 0.38,
            close: 0.42,
          },
          {
            platform: 'POLYMARKET',
            contractId,
            source: 'PREDEXON',
            intervalMinutes: 1,
            timestamp: new Date('2024-07-02T10:00:00Z'),
            open: 0.6,
            high: 0.65,
            low: 0.58,
            close: 0.62,
          },
        ],
      });

      const agg = await prisma.historicalPrice.aggregate({
        where: { contractId },
        _count: { id: true },
        _avg: { close: true },
      });
      expect(agg._count.id).toBe(2);
      expect(Number(agg._avg.close)).toBeCloseTo(0.52, 5);

      const groups = await prisma.historicalPrice.groupBy({
        by: ['platform'],
        where: { contractId },
        _count: { id: true },
      });
      expect(groups).toHaveLength(2);
      const kalshi = groups.find((r) => r.platform === 'KALSHI');
      const poly = groups.find((r) => r.platform === 'POLYMARKET');
      expect(kalshi?._count.id).toBe(1);
      expect(poly?._count.id).toBe(1);

      await prisma.historicalPrice.deleteMany({
        where: { contractId },
      });
    });
  },
);

// --- Story 10-95-2: historical_depths hypertable tests ---

describe.runIf(DATABASE_URL)(
  'TimescaleDB Migration — historical_depths',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
      });
      await prisma.$connect();
      await prisma.historicalDepth.deleteMany({
        where: {
          contractId: { startsWith: 'test-timescaledb-migration-' },
        },
      });
    });

    afterAll(async () => {
      await prisma.historicalDepth.deleteMany({
        where: {
          contractId: { startsWith: 'test-timescaledb-migration-' },
        },
      });
      await prisma.$disconnect();
    });

    // --- P0: Hypertable verification ---

    it('[P0] historical_depths is a hypertable', async () => {
      const result = await prisma.$queryRaw<
        { hypertable_name: string }[]
      >`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'historical_depths'`;

      expect(result).toHaveLength(1);
      expect(result[0].hypertable_name).toBe('historical_depths');
    });

    it('[P0] chunk interval is 1 day', async () => {
      const result = await prisma.$queryRaw<
        { time_interval: string }[]
      >`SELECT d.time_interval::text FROM timescaledb_information.dimensions d JOIN timescaledb_information.hypertables h ON d.hypertable_name = h.hypertable_name WHERE h.hypertable_name = 'historical_depths'`;

      expect(result).toHaveLength(1);
      expect(result[0].time_interval).toBe('1 day');
    });

    // --- P0: Constraint verification ---

    it('[P0] composite PK exists: (id, timestamp)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = 'historical_depths'
        ORDER BY kcu.ordinal_position`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual(['id', 'timestamp']);
    });

    it('[P0] unique constraint includes timestamp (4 columns)', async () => {
      const result = await prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE c.relname = 'historical_depths_platform_contract_id_source_timestamp_key'
          AND i.indisunique = true
        ORDER BY array_position(i.indkey, a.attnum)`;

      const columns = result.map((r) => r.column_name);
      expect(columns).toEqual([
        'platform',
        'contract_id',
        'source',
        'timestamp',
      ]);
    });

    // --- P1: Dropped indexes ---

    it('[P1] dropped index no longer exists', async () => {
      const result = await prisma.$queryRaw<
        { indexname: string }[]
      >`SELECT indexname FROM pg_indexes
        WHERE tablename = 'historical_depths'
          AND indexname = 'historical_depths_timestamp_idx'`;

      expect(result).toHaveLength(0);
    });

    // --- P1: Kept indexes ---

    it('[P1] kept indexes still exist', async () => {
      const result = await prisma.$queryRaw<
        { indexname: string }[]
      >`SELECT indexname FROM pg_indexes
        WHERE tablename = 'historical_depths'
          AND indexname IN (
            'historical_depths_platform_contract_id_timestamp_idx',
            'historical_depths_source_timestamp_idx',
            'historical_depths_contract_id_source_timestamp_idx'
          )
        ORDER BY indexname`;

      expect(result).toHaveLength(3);
      expect(result.map((r) => r.indexname)).toEqual([
        'historical_depths_contract_id_source_timestamp_idx',
        'historical_depths_platform_contract_id_timestamp_idx',
        'historical_depths_source_timestamp_idx',
      ]);
    });

    // --- P1: CRUD operations ---

    it('[P1] createMany idempotency (skipDuplicates: true)', async () => {
      const depth = {
        platform: 'POLYMARKET' as const,
        contractId: 'test-timescaledb-migration-d-001',
        source: 'PMXT_ARCHIVE' as const,
        bids: [{ price: 0.5, size: 100 }],
        asks: [{ price: 0.55, size: 200 }],
        timestamp: new Date('2024-06-15T12:00:00Z'),
      };

      await prisma.historicalDepth.deleteMany({
        where: { contractId: depth.contractId },
      });

      const first = await prisma.historicalDepth.createMany({
        data: [depth],
        skipDuplicates: true,
      });
      expect(first.count).toBe(1);

      const second = await prisma.historicalDepth.createMany({
        data: [depth],
        skipDuplicates: true,
      });
      expect(second.count).toBe(0);

      const count = await prisma.historicalDepth.count({
        where: { contractId: depth.contractId },
      });
      expect(count).toBe(1);

      await prisma.historicalDepth.deleteMany({
        where: { contractId: depth.contractId },
      });
    });

    it('[P1] findFirst returns correct result', async () => {
      const contractId = 'test-timescaledb-migration-d-002';

      await prisma.historicalDepth.deleteMany({
        where: { contractId },
      });

      await prisma.historicalDepth.createMany({
        data: [
          {
            platform: 'POLYMARKET',
            contractId,
            source: 'PMXT_ARCHIVE',
            bids: [{ price: 0.4, size: 50 }],
            asks: [{ price: 0.45, size: 80 }],
            timestamp: new Date('2024-06-10T10:00:00Z'),
          },
          {
            platform: 'POLYMARKET',
            contractId,
            source: 'PMXT_ARCHIVE',
            bids: [{ price: 0.5, size: 60 }],
            asks: [{ price: 0.55, size: 90 }],
            timestamp: new Date('2024-06-15T10:00:00Z'),
          },
        ],
      });

      const result = await prisma.historicalDepth.findFirst({
        where: {
          contractId,
          timestamp: { gte: new Date('2024-06-12T00:00:00Z') },
        },
        orderBy: { timestamp: 'asc' },
      });

      expect(result).not.toBeNull();
      expect(result!.timestamp).toEqual(new Date('2024-06-15T10:00:00Z'));

      await prisma.historicalDepth.deleteMany({
        where: { contractId },
      });
    });

    it('[P1] aggregate + groupBy work on hypertable', async () => {
      const contractId = 'test-timescaledb-migration-d-003';

      await prisma.historicalDepth.deleteMany({
        where: { contractId },
      });

      await prisma.historicalDepth.createMany({
        data: [
          {
            platform: 'KALSHI',
            contractId,
            source: 'PREDEXON',
            bids: [{ price: 0.4, size: 50 }],
            asks: [{ price: 0.45, size: 80 }],
            timestamp: new Date('2024-07-01T10:00:00Z'),
          },
          {
            platform: 'POLYMARKET',
            contractId,
            source: 'PMXT_ARCHIVE',
            bids: [{ price: 0.5, size: 60 }],
            asks: [{ price: 0.55, size: 90 }],
            timestamp: new Date('2024-07-02T10:00:00Z'),
          },
        ],
      });

      const agg = await prisma.historicalDepth.aggregate({
        where: { contractId },
        _count: { id: true },
      });
      expect(agg._count.id).toBe(2);

      const groups = await prisma.historicalDepth.groupBy({
        by: ['platform'],
        where: { contractId },
        _count: { id: true },
      });
      expect(groups).toHaveLength(2);
      const kalshi = groups.find((r) => r.platform === 'KALSHI');
      const poly = groups.find((r) => r.platform === 'POLYMARKET');
      expect(kalshi?._count.id).toBe(1);
      expect(poly?._count.id).toBe(1);

      await prisma.historicalDepth.deleteMany({
        where: { contractId },
      });
    });
  },
);
