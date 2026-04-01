import { Platform, HistoricalDataSource } from '@prisma/client';
import type { PrismaService } from '../../../common/prisma.service';

export interface PriceRecord {
  platform: Platform;
  contractId: string;
  source: HistoricalDataSource;
  intervalMinutes: number;
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
}

export interface DepthRecord {
  platform: Platform;
  contractId: string;
  source: HistoricalDataSource;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: Date;
  updateType: string;
}

export interface TradeRecord {
  platform: Platform;
  contractId: string;
  source: HistoricalDataSource;
  externalTradeId: string;
  price: string;
  size: string;
  side: string;
  timestamp: Date;
}

/**
 * Raw SQL bulk INSERT bypassing Prisma ORM overhead (10-50x faster than createMany).
 * Uses parameterized queries ($1, $2, ...) + ON CONFLICT DO NOTHING for idempotency.
 */
export async function bulkInsertPrices(
  prisma: PrismaService,
  records: PriceRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const values = records
    .map((_, i) => {
      const o = i * 10;
      return `($${o + 1}::"Platform",$${o + 2},$${o + 3}::"HistoricalDataSource",$${o + 4}::int,$${o + 5}::timestamptz,$${o + 6}::decimal,$${o + 7}::decimal,$${o + 8}::decimal,$${o + 9}::decimal,$${o + 10}::decimal)`;
    })
    .join(',');
  const params = records.flatMap((r) => [
    r.platform,
    r.contractId,
    r.source,
    r.intervalMinutes,
    r.timestamp.toISOString(),
    r.open,
    r.high,
    r.low,
    r.close,
    r.volume,
  ]);
  return prisma.$executeRawUnsafe(
    `INSERT INTO historical_prices (platform,contract_id,source,interval_minutes,timestamp,open,high,low,close,volume)
     VALUES ${values}
     ON CONFLICT (platform,contract_id,source,interval_minutes,timestamp) DO NOTHING`,
    ...params,
  );
}

export async function bulkInsertDepth(
  prisma: PrismaService,
  records: DepthRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const values = records
    .map((_, i) => {
      const o = i * 7;
      return `($${o + 1}::"Platform",$${o + 2},$${o + 3}::"HistoricalDataSource",$${o + 4}::jsonb,$${o + 5}::jsonb,$${o + 6}::timestamptz,$${o + 7})`;
    })
    .join(',');
  const params = records.flatMap((r) => [
    r.platform,
    r.contractId,
    r.source,
    JSON.stringify(r.bids),
    JSON.stringify(r.asks),
    r.timestamp.toISOString(),
    r.updateType,
  ]);
  return prisma.$executeRawUnsafe(
    `INSERT INTO historical_depths (platform,contract_id,source,bids,asks,timestamp,update_type)
     VALUES ${values}
     ON CONFLICT (platform,contract_id,source,timestamp) DO NOTHING`,
    ...params,
  );
}

export async function bulkInsertTrades(
  prisma: PrismaService,
  records: TradeRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const values = records
    .map((_, i) => {
      const o = i * 8;
      return `($${o + 1}::"Platform",$${o + 2},$${o + 3}::"HistoricalDataSource",$${o + 4},$${o + 5}::decimal,$${o + 6}::decimal,$${o + 7},$${o + 8}::timestamptz)`;
    })
    .join(',');
  const params = records.flatMap((r) => [
    r.platform,
    r.contractId,
    r.source,
    r.externalTradeId,
    r.price,
    r.size,
    r.side,
    r.timestamp.toISOString(),
  ]);
  return prisma.$executeRawUnsafe(
    `INSERT INTO historical_trades (platform,contract_id,source,external_trade_id,price,size,side,timestamp)
     VALUES ${values}
     ON CONFLICT (platform,contract_id,source,external_trade_id) DO NOTHING`,
    ...params,
  );
}
