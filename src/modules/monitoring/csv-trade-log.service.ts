import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

export interface TradeLogRecord {
  timestamp: string;
  platform: string;
  contractId: string;
  side: string;
  price: string;
  size: string;
  fillPrice: string;
  fees: string;
  gas: string;
  edge: string;
  pnl: string;
  positionId: string;
  pairId: string;
  isPaper: boolean;
  correlationId: string;
}

const CSV_HEADER =
  'timestamp,platform,contract_id,side,price,size,fill_price,fees,gas,edge,pnl,position_id,pair_id,is_paper,correlation_id';

export function escapeCsvField(value: string): string {
  // Prevent CSV injection: prefix formula-triggering chars with single quote
  // (skip numeric values like "-15.50" which are legitimate trade data)
  if (/^[=+@-]/.test(value) && isNaN(Number(value))) {
    value = `'${value}`;
  }
  if (/[,"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatCsvRow(record: TradeLogRecord): string {
  return [
    escapeCsvField(record.timestamp),
    escapeCsvField(record.platform),
    escapeCsvField(record.contractId),
    escapeCsvField(record.side),
    escapeCsvField(record.price),
    escapeCsvField(record.size),
    escapeCsvField(record.fillPrice),
    escapeCsvField(record.fees),
    escapeCsvField(record.gas),
    escapeCsvField(record.edge),
    escapeCsvField(record.pnl),
    escapeCsvField(record.positionId),
    escapeCsvField(record.pairId),
    String(record.isPaper),
    escapeCsvField(record.correlationId),
  ].join(',');
}

export function getCsvHeader(): string {
  return CSV_HEADER;
}

export function formatDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

@Injectable()
export class CsvTradeLogService implements OnModuleInit {
  private readonly logger = new Logger(CsvTradeLogService.name);
  private enabled = true;
  private logDir: string;
  private writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly configService: ConfigService) {
    this.logDir =
      this.configService.get<string>('CSV_TRADE_LOG_DIR') ??
      path.join(process.cwd(), 'data', 'trade-logs');
  }

  async onModuleInit(): Promise<void> {
    const csvEnabled = this.configService.get<string>('CSV_ENABLED');
    if (csvEnabled === 'false') {
      this.enabled = false;
      this.logger.log({
        message: 'CSV trade logging disabled via CSV_ENABLED=false',
        module: 'monitoring',
      });
      return;
    }

    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.access(
        this.logDir,

        (await import('fs')).constants.W_OK,
      );
      this.enabled = true;
      this.logger.log({
        message: `CSV trade logging enabled — dir: ${this.logDir}`,
        module: 'monitoring',
      });
    } catch (error) {
      this.enabled = false;
      this.logger.error({
        message: 'CSV trade log directory not writable — CSV logging disabled',
        code: MONITORING_ERROR_CODES.CSV_WRITE_FAILED,
        component: 'csv-trade-logging',
        error: String(error),
        module: 'monitoring',
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async logTrade(record: TradeLogRecord): Promise<void> {
    if (!this.enabled) return;

    const date = new Date(record.timestamp);
    const filename = `trades-${formatDateUTC(date)}.csv`;
    const filepath = path.join(this.logDir, filename);

    return this.enqueueWrite(filepath, async () => {
      await this.appendRow(filepath, record);
    });
  }

  /** Append trade row to daily summary CSV. Used by DailySummaryService. */
  async appendSummaryRow(row: string): Promise<void> {
    if (!this.enabled) return;

    const filepath = path.join(this.logDir, 'daily-summaries.csv');
    return this.enqueueWrite(filepath, async () => {
      const needsHeader = await this.fileNeedsHeader(filepath);
      if (needsHeader) {
        await fs.appendFile(
          filepath,
          'date,total_trades,total_pnl,open_positions,closed_positions,opportunities_detected,opportunities_executed,single_leg_events,risk_limit_events,system_health_summary\n',
        );
      }
      await fs.appendFile(filepath, row + '\n');
    });
  }

  private enqueueWrite(
    filepath: string,
    writeFn: () => Promise<void>,
  ): Promise<void> {
    const prev = this.writeQueues.get(filepath) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        /* ignore previous failure — each write is independent */
      })
      .then(writeFn)
      .catch((err) => this.handleWriteError(err));
    this.writeQueues.set(filepath, next);
    return next;
  }

  private async appendRow(
    filepath: string,
    record: TradeLogRecord,
  ): Promise<void> {
    const needsHeader = await this.fileNeedsHeader(filepath);
    if (needsHeader) {
      await fs.appendFile(filepath, getCsvHeader() + '\n');
    }
    await fs.appendFile(filepath, formatCsvRow(record) + '\n');
  }

  private async fileNeedsHeader(filepath: string): Promise<boolean> {
    try {
      await fs.stat(filepath);
      return false;
    } catch {
      return true;
    }
  }

  private handleWriteError(error: unknown): void {
    this.logger.error({
      message: 'CSV trade log write failed',
      code: MONITORING_ERROR_CODES.CSV_WRITE_FAILED,
      component: 'csv-trade-logging',
      error: String(error),
      module: 'monitoring',
    });
    // NEVER re-throw — CSV write failure must not block trading
  }
}
