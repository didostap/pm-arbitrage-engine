import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { Platform } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import type { NormalizedHistoricalDepth } from '../types/normalized-historical.types';
import type { IngestionMetadata } from '../../../common/types/historical-data.types';

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes for large files
const HTTP_TIMEOUT_MS = 30_000;

interface PmxtFileInfo {
  url: string;
  filename: string;
  hourTimestamp: Date;
}

@Injectable()
export class PmxtArchiveService implements OnModuleDestroy {
  private readonly logger = new Logger(PmxtArchiveService.name);
  private readonly listingUrl: string;
  private readonly baseUrl: string;
  private readonly localDir: string;

  /** 2 deps: PrismaService + ConfigService (leaf) */
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const configUrl =
      this.configService.get<string>('PMXT_ARCHIVE_BASE_URL') ??
      'https://archive.pmxt.dev';
    // Listing page is at the site root; downloads are under /dumps/
    this.listingUrl = configUrl.replace(/\/+$/, '') + '/dumps';
    this.baseUrl = configUrl.replace(/\/+$/, '') + '/dumps/';
    this.localDir =
      this.configService.get<string>('PMXT_ARCHIVE_LOCAL_DIR') ??
      'data/pmxt-archive';
  }

  onModuleDestroy(): void {
    // No persistent caches to clear — all state is per-call
  }

  async discoverFiles(dateRange: {
    start: Date;
    end: Date;
  }): Promise<PmxtFileInfo[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(this.listingUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_DEPTH_INGESTION_FAILURE,
          `PMXT Archive directory listing failed: ${res.status}`,
          'error',
          'pmxt-archive',
        );
      }

      const html = await res.text();
      const files: PmxtFileInfo[] = [];

      // PMXT Archive serves a Next.js app — filenames are in JSON inside <script> tags
      // Match both classic HTML href="..." and React JSON "href":"/dumps/..." patterns
      const patterns = [
        // Classic HTML directory listing
        /href="(polymarket_orderbook_(\d{4}-\d{2}-\d{2}T\d{2})\.parquet)"/g,
        // Next.js React JSON payload (escaped quotes in <script> tags)
        /(?:href|"href")(?:=|:)\\?"(?:\/dumps\/)?(polymarket_orderbook_(\d{4}-\d{2}-\d{2}T\d{2})\.parquet)\\?"/g,
      ];

      /** Cleanup: rebuilt per discoverFiles call */
      const seen = new Set<string>();

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) !== null) {
          const filename = match[1]!;
          if (seen.has(filename)) continue;
          seen.add(filename);

          const hourStr = match[2]!;
          const hourTimestamp = new Date(`${hourStr}:00:00Z`);

          if (
            hourTimestamp >= dateRange.start &&
            hourTimestamp <= dateRange.end
          ) {
            files.push({
              url: `${this.baseUrl}${filename}`,
              filename,
              hourTimestamp,
            });
          }
        }
      }

      return files;
    } finally {
      clearTimeout(timeout);
    }
  }

  async downloadAndCatalog(fileInfo: PmxtFileInfo): Promise<{
    localPath: string;
    checksum: string;
    skipped: boolean;
  }> {
    const localPath = `${this.localDir}/${fileInfo.filename}`;

    // Check if already downloaded and complete
    const existing = await this.prisma.dataCatalog.findUnique({
      where: {
        source_filePath: {
          source: 'PMXT_ARCHIVE',
          filePath: localPath,
        },
      },
    });

    if (existing?.status === 'COMPLETE' && existing.checksum) {
      return { localPath, checksum: existing.checksum, skipped: true };
    }

    // Upsert catalog entry as PROCESSING
    await this.prisma.dataCatalog.upsert({
      where: {
        source_filePath: {
          source: 'PMXT_ARCHIVE',
          filePath: localPath,
        },
      },
      update: { status: 'PROCESSING' },
      create: {
        source: 'PMXT_ARCHIVE',
        filePath: localPath,
        status: 'PROCESSING',
        timeRangeStart: fileInfo.hourTimestamp,
        timeRangeEnd: new Date(
          fileInfo.hourTimestamp.getTime() + 60 * 60 * 1000,
        ),
      },
    });

    // Download with retry
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const checksum = await this.downloadFile(fileInfo.url, localPath);

        // Update catalog as COMPLETE
        await this.prisma.dataCatalog.upsert({
          where: {
            source_filePath: {
              source: 'PMXT_ARCHIVE',
              filePath: localPath,
            },
          },
          update: { status: 'COMPLETE', checksum },
          create: {
            source: 'PMXT_ARCHIVE',
            filePath: localPath,
            status: 'COMPLETE',
            checksum,
            timeRangeStart: fileInfo.hourTimestamp,
            timeRangeEnd: new Date(
              fileInfo.hourTimestamp.getTime() + 60 * 60 * 1000,
            ),
          },
        });

        return { localPath, checksum, skipped: false };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Download attempt ${attempt + 1}/${MAX_RETRIES} failed for ${fileInfo.filename}: ${lastError.message}`,
        );

        if (attempt < MAX_RETRIES - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          const jitter = delay * (0.9 + Math.random() * 0.2);
          await new Promise((r) => setTimeout(r, jitter));
        }
      }
    }

    // All retries exhausted
    await this.prisma.dataCatalog.upsert({
      where: {
        source_filePath: {
          source: 'PMXT_ARCHIVE',
          filePath: localPath,
        },
      },
      update: { status: 'FAILED' },
      create: {
        source: 'PMXT_ARCHIVE',
        filePath: localPath,
        status: 'FAILED',
        timeRangeStart: fileInfo.hourTimestamp,
        timeRangeEnd: new Date(
          fileInfo.hourTimestamp.getTime() + 60 * 60 * 1000,
        ),
      },
    });

    throw new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_DEPTH_INGESTION_FAILURE,
      `PMXT Archive download failed after ${MAX_RETRIES} retries: ${fileInfo.filename}`,
      'error',
      'pmxt-archive',
      {
        maxRetries: MAX_RETRIES,
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        backoffMultiplier: 2,
      },
      { lastError: lastError?.message },
    );
  }

  async parseParquetDepth(
    filePath: string,
    targetTokenIds: Set<string>,
  ): Promise<NormalizedHistoricalDepth[]> {
    try {
      const { asyncBufferFromFile, parquetRead } = await import('hyparquet');
      const { compressors } = await import('hyparquet-compressors');

      const file = await asyncBufferFromFile(filePath);
      const results: NormalizedHistoricalDepth[] = [];

      // NOTE: onComplete receives all matching rows in memory. hyparquet's onChunk
      // provides column-oriented ColumnData which would require a larger refactor.
      // Column filtering via `columns` parameter reduces memory by skipping irrelevant columns.
      await parquetRead({
        file,
        compressors,
        columns: [
          'asset_id',
          'token_id',
          'timestamp',
          'update_type',
          'bids',
          'asks',
          'bid_levels',
          'ask_levels',
        ],
        rowFormat: 'object',
        onComplete: (rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            const rawId = row.asset_id ?? row.token_id ?? '';
            const assetId =
              typeof rawId === 'string' ? rawId : JSON.stringify(rawId);
            if (!targetTokenIds.has(assetId)) continue;

            const rawType = row.update_type ?? '';
            const updateType = typeof rawType === 'string' ? rawType : '';
            if (updateType !== 'book_snapshot') continue;

            const bids = this.parseOrderLevels(row.bids ?? row.bid_levels);
            const asks = this.parseOrderLevels(row.asks ?? row.ask_levels);

            // P-13: Detect timestamp magnitude (seconds vs ms vs microseconds)
            const ts = row.timestamp;
            let timestamp: Date;
            if (ts instanceof Date) {
              timestamp = ts;
            } else if (typeof ts === 'number') {
              if (ts > 1e15)
                timestamp = new Date(ts / 1000); // microseconds
              else if (ts > 1e12)
                timestamp = new Date(ts); // milliseconds
              else timestamp = new Date(ts * 1000); // seconds
            } else {
              timestamp = new Date(String(ts));
            }

            results.push({
              platform: Platform.POLYMARKET,
              contractId: assetId,
              source: 'PMXT_ARCHIVE',
              bids,
              asks,
              timestamp,
              updateType: 'snapshot',
            });
          }
        },
      });

      return results;
    } catch (error) {
      if (
        error instanceof SystemHealthError &&
        error.code === SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PARQUET_PARSE_ERROR
      ) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PARQUET_PARSE_ERROR,
        `Parquet parse failed for ${filePath}: ${msg}`,
        'error',
        'pmxt-archive',
        undefined,
        { filePath },
      );
    }
  }

  async ingestDepth(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();

    // Discover files in range
    const files = await this.discoverFiles(dateRange);

    // P-5: Sample per-file to reduce peak memory (shared seenHours across files)
    /** Cleanup: rebuilt per ingestDepth call, not persisted across calls */
    const seenHours = new Set<string>();
    const sampledDepths: NormalizedHistoricalDepth[] = [];

    for (const fileInfo of files) {
      // Download & catalog
      const { localPath } = await this.downloadAndCatalog(fileInfo);

      // Parse and filter
      const depths = await this.parseParquetDepth(
        localPath,
        new Set([contractId]),
      );

      // Sample per-file, sharing seenHours across files for cross-file dedup
      const fileSampled = this.samplePerUtcHour(depths, seenHours);
      sampledDepths.push(...fileSampled);
    }

    // Batch persist
    let totalInserted = 0;
    for (let i = 0; i < sampledDepths.length; i += BATCH_SIZE) {
      const batch = sampledDepths.slice(i, i + BATCH_SIZE);
      const result = await this.prisma.historicalDepth.createMany({
        data: batch.map((d) => ({
          platform: Platform.POLYMARKET,
          contractId: d.contractId,
          source: 'PMXT_ARCHIVE' as const,
          bids: d.bids.map((b) => ({
            price: b.price.toString(),
            size: b.size.toString(),
          })),
          asks: d.asks.map((a) => ({
            price: a.price.toString(),
            size: a.size.toString(),
          })),
          timestamp: d.timestamp,
          updateType: d.updateType,
        })),
        skipDuplicates: true,
      });
      totalInserted += result.count;
    }

    return {
      source: 'PMXT_ARCHIVE',
      platform: Platform.POLYMARKET,
      contractId,
      recordCount: totalInserted,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  /** P-5: Accepts external seenHours Set for cross-file dedup */
  private samplePerUtcHour(
    depths: NormalizedHistoricalDepth[],
    seenHours?: Set<string>,
  ): NormalizedHistoricalDepth[] {
    const sorted = [...depths].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const hours = seenHours ?? new Set<string>();
    const sampled: NormalizedHistoricalDepth[] = [];

    for (const d of sorted) {
      const hourKey = `${d.contractId}:${new Date(
        Date.UTC(
          d.timestamp.getUTCFullYear(),
          d.timestamp.getUTCMonth(),
          d.timestamp.getUTCDate(),
          d.timestamp.getUTCHours(),
        ),
      ).toISOString()}`;

      if (!hours.has(hourKey)) {
        hours.add(hourKey);
        sampled.push(d);
      }
    }

    return sampled;
  }

  private parseOrderLevels(
    raw: unknown,
  ): Array<{ price: number; size: number }> {
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Record<string, unknown>>).map((level) => {
      const rawPrice = level.price ?? level.p ?? '0';
      const rawSize = level.size ?? level.s ?? level.quantity ?? '0';
      return {
        price: Number(
          typeof rawPrice === 'string' || typeof rawPrice === 'number'
            ? rawPrice
            : 0,
        ),
        size: Number(
          typeof rawSize === 'string' || typeof rawSize === 'number'
            ? rawSize
            : 0,
        ),
      };
    });
  }

  // P-9: Transform stream for checksumming (replaces data listener race)
  // P-19: Partial file cleanup on error
  private async downloadFile(url: string, localPath: string): Promise<string> {
    const dir = localPath.substring(0, localPath.lastIndexOf('/'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const hash = createHash('sha256');
      const body = res.body;
      if (!body) {
        throw new Error('Response body is null');
      }

      const writeStream = createWriteStream(localPath);
      const nodeReadable = Readable.fromWeb(body as any);

      const hashTransform = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      await pipeline(nodeReadable, hashTransform, writeStream);
      return hash.digest('hex');
    } catch (error) {
      // P-19: Clean up partial file on failure
      try {
        unlinkSync(localPath);
      } catch {
        /* file may not exist */
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
