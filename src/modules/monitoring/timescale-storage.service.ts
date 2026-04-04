import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';
import { ConfigAccessor } from '../../common/config/config-accessor.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { TimescaleRetentionCompletedEvent } from '../../common/events/timescale-retention-completed.event.js';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import type {
  CompressionResult,
  StorageStats,
  TableStorageStats,
} from './timescale-storage.types.js';

const HYPERTABLES = [
  'historical_prices',
  'historical_depths',
  'historical_trades',
] as const;

type HypertableName = (typeof HYPERTABLES)[number];

const RETENTION_CONFIG_KEYS: Record<
  HypertableName,
  | 'retentionDaysHistoricalPrices'
  | 'retentionDaysHistoricalTrades'
  | 'retentionDaysHistoricalDepths'
> = {
  historical_prices: 'retentionDaysHistoricalPrices',
  historical_depths: 'retentionDaysHistoricalDepths',
  historical_trades: 'retentionDaysHistoricalTrades',
};

/** Validates chunk names from timescaledb_information.chunks (format: _timescaledb_internal._hyper_N_N_chunk) */
const CHUNK_NAME_PATTERN = /^_timescaledb_internal\._hyper_\d+_\d+_chunk$/;

@Injectable()
export class TimescaleStorageService implements OnModuleInit {
  private readonly logger = new Logger(TimescaleStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configAccessor: ConfigAccessor,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    setImmediate(() => {
      void this.compressOldChunks().catch((err) =>
        this.logger.error({
          message: 'Startup compression failed',
          error: err instanceof Error ? err.stack : String(err),
          module: 'monitoring',
        }),
      );
    });
  }

  @Cron('0 4 * * *', { timeZone: 'UTC' })
  async handleRetention(): Promise<void> {
    await withCorrelationId(async () => {
      const startMs = Date.now();
      const droppedChunks: Record<string, number> = {};

      try {
        const config = await this.configAccessor.get();

        for (const table of HYPERTABLES) {
          const configKey = RETENTION_CONFIG_KEYS[table];
          const days = config[configKey];

          if (!Number.isInteger(days) || days < 30) {
            const healthError = new SystemHealthError(
              SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
              `Invalid retention value for ${table}: ${days}. Must be integer >= 30. Skipping.`,
              'warning',
              'TimescaleStorageService',
              undefined,
              { table, days },
            );
            this.logger.error({
              message: healthError.message,
              module: 'monitoring',
              data: { table, days, errorCode: healthError.code },
            });
            continue;
          }

          try {
            const result = await this.prisma.$queryRaw<
              { drop_chunks: string }[]
            >(
              Prisma.sql`SELECT drop_chunks(${Prisma.raw(`'${table}'`)}::regclass, older_than => INTERVAL '1 day' * ${days}::int)`,
            );
            droppedChunks[table] = result.length;

            this.logger.log({
              message: `Retention: dropped ${result.length} chunks from ${table} older than ${days} days`,
              module: 'monitoring',
              data: { table, days, droppedCount: result.length },
            });
          } catch (error) {
            const healthError = new SystemHealthError(
              SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
              `Retention failed for ${table}`,
              'error',
              'TimescaleStorageService',
              undefined,
              {
                table,
                days,
                cause:
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error),
              },
            );
            this.logger.error({
              message: healthError.message,
              module: 'monitoring',
              data: { table, days, errorCode: healthError.code },
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
            });
            droppedChunks[table] = 0;
          }
        }

        const durationMs = Date.now() - startMs;
        this.eventEmitter.emit(
          EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
          new TimescaleRetentionCompletedEvent(droppedChunks, durationMs),
        );

        this.logger.log({
          message: 'Retention cron completed',
          module: 'monitoring',
          data: { droppedChunks, durationMs },
        });
      } catch (error) {
        const durationMs = Date.now() - startMs;
        const healthError = new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
          'Retention cron failed',
          'error',
          'TimescaleStorageService',
          undefined,
          {
            cause:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          },
        );
        this.logger.error({
          message: healthError.message,
          module: 'monitoring',
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          errorCode: healthError.code,
        });

        // Emit event with empty results so operator gets Telegram notification of failure
        this.eventEmitter.emit(
          EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
          new TimescaleRetentionCompletedEvent(droppedChunks, durationMs),
        );

        // NEVER re-throw — retention failure must not block trading
      }
    });
  }

  async compressOldChunks(): Promise<CompressionResult> {
    const tables: CompressionResult['tables'] = [];
    let totalChunksCompressed = 0;

    for (const table of HYPERTABLES) {
      try {
        const chunks = await this.prisma.$queryRaw<
          { chunk_full_name: string }[]
        >(
          Prisma.sql`SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk_full_name
            FROM timescaledb_information.chunks
            WHERE hypertable_name = ${table}
              AND NOT is_compressed
              AND range_end < NOW() - INTERVAL '7 days'
            ORDER BY range_start ASC`,
        );

        let compressed = 0;
        for (let i = 0; i < chunks.length; i++) {
          const chunkName = chunks[i]!.chunk_full_name;

          if (!CHUNK_NAME_PATTERN.test(chunkName)) {
            this.logger.error({
              message: `Unexpected chunk name format, skipping: ${chunkName}`,
              module: 'monitoring',
              data: { table, chunkName },
            });
            continue;
          }

          try {
            await this.prisma.$queryRaw(
              Prisma.sql`SELECT compress_chunk(${Prisma.raw(`'${chunkName}'`)}::regclass)`,
            );
            compressed++;
            this.logger.log({
              message: `Compressed chunk ${i + 1} of ${chunks.length} for ${table}`,
              module: 'monitoring',
            });
          } catch (error) {
            this.logger.error({
              message: `Failed to compress chunk ${chunkName}`,
              module: 'monitoring',
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
            });
          }
        }

        tables.push({ tableName: table, chunksCompressed: compressed });
        totalChunksCompressed += compressed;
      } catch (error) {
        this.logger.error({
          message: `Failed to list uncompressed chunks for ${table}`,
          module: 'monitoring',
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
        tables.push({ tableName: table, chunksCompressed: 0 });
      }
    }

    return { tables, totalChunksCompressed };
  }

  async getStorageStats(): Promise<StorageStats> {
    try {
      const [dbSizeResult] = await this.prisma.$queryRaw<
        { pg_size_pretty: string }[]
      >(
        Prisma.sql`SELECT pg_size_pretty(pg_database_size(current_database()))`,
      );

      const tableStats: TableStorageStats[] = [];

      for (const table of HYPERTABLES) {
        const [compressionStats] = await this.prisma.$queryRaw<
          {
            hypertable_name: string;
            total_chunks: number;
            compressed_chunks: number;
            before_compression: string;
            after_compression: string;
            compression_ratio_pct: number;
          }[]
        >(
          Prisma.sql`SELECT
            ${Prisma.raw(`'${table}'`)} AS hypertable_name,
            COALESCE(total_chunks, 0)::int AS total_chunks,
            COALESCE(number_compressed_chunks, 0)::int AS compressed_chunks,
            pg_size_pretty(COALESCE(before_compression_total_bytes, 0)) AS before_compression,
            pg_size_pretty(COALESCE(after_compression_total_bytes, 0)) AS after_compression,
            ROUND(
              COALESCE(1 - after_compression_total_bytes::numeric
                / NULLIF(before_compression_total_bytes, 0), 0) * 100, 1
            )::float AS compression_ratio_pct
          FROM hypertable_compression_stats(${Prisma.raw(`'${table}'`)})`,
        );

        const [sizeResult] = await this.prisma.$queryRaw<
          { total_size: string }[]
        >(
          Prisma.sql`SELECT pg_size_pretty(hypertable_size(${Prisma.raw(`'${table}'`)}::regclass)) AS total_size`,
        );

        tableStats.push({
          tableName: table,
          totalSize: sizeResult?.total_size ?? '0 bytes',
          compressedSize: compressionStats?.after_compression ?? null,
          uncompressedSize: compressionStats?.before_compression ?? null,
          compressionRatioPct: compressionStats?.compression_ratio_pct ?? 0,
          totalChunks: compressionStats?.total_chunks ?? 0,
          compressedChunks: compressionStats?.compressed_chunks ?? 0,
        });
      }

      return {
        totalDatabaseSize: dbSizeResult?.pg_size_pretty ?? '0 bytes',
        tables: tableStats,
      };
    } catch (error) {
      this.logger.error({
        message: 'Failed to retrieve storage stats',
        module: 'monitoring',
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
      return {
        totalDatabaseSize: 'unavailable',
        tables: [],
      };
    }
  }
}
