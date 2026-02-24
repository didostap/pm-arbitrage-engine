import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventConsumerService } from './event-consumer.service.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import {
  CsvTradeLogService,
  escapeCsvField,
  formatDateUTC,
} from './csv-trade-log.service.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { PositionRepository } from '../../persistence/repositories/position.repository.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';
import { escapeHtml } from './formatters/telegram-message.formatter.js';

@Injectable()
export class DailySummaryService {
  private readonly logger = new Logger(DailySummaryService.name);

  constructor(
    private readonly eventConsumerService: EventConsumerService,
    private readonly telegramAlertService: TelegramAlertService,
    private readonly csvTradeLogService: CsvTradeLogService,
    private readonly orderRepository: OrderRepository,
    private readonly positionRepository: PositionRepository,
  ) {}

  @Cron('0 0 * * *', { timeZone: 'UTC' })
  async handleDailySummary(): Promise<void> {
    await withCorrelationId(async () => {
      try {
        const yesterday = this.getYesterdayRange();
        const summary = await this.buildSummary(yesterday.start, yesterday.end);

        // Write to CSV
        const csvRow = this.formatSummaryRow(yesterday.dateStr, summary);
        await this.csvTradeLogService.appendSummaryRow(csvRow);

        // Send Telegram
        const message = this.formatTelegramMessage(yesterday.dateStr, summary);
        await this.telegramAlertService.enqueueAndSend(message, 'info');

        this.logger.log({
          message: `Daily summary generated for ${yesterday.dateStr}`,
          module: 'monitoring',
          data: summary,
        });
      } catch (error) {
        this.logger.error({
          message: 'Daily summary generation failed',
          code: MONITORING_ERROR_CODES.EVENT_CONSUMER_HANDLER_FAILED,
          error: String(error),
          module: 'monitoring',
        });
        // NEVER re-throw — daily summary failure must not block trading
      }
    });
  }

  private getYesterdayRange(): {
    start: Date;
    end: Date;
    dateStr: string;
  } {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const start = new Date(
      Date.UTC(
        yesterday.getUTCFullYear(),
        yesterday.getUTCMonth(),
        yesterday.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        yesterday.getUTCFullYear(),
        yesterday.getUTCMonth(),
        yesterday.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );

    return { start, end, dateStr: formatDateUTC(yesterday) };
  }

  private async buildSummary(
    start: Date,
    end: Date,
  ): Promise<DailySummaryData> {
    const metrics = this.eventConsumerService.getMetrics();

    const [totalTrades, openPositions, closedPositions, totalPnl] =
      await Promise.all([
        this.orderRepository.countByDateRange(start, end),
        this.positionRepository.countByStatus('OPEN'),
        this.positionRepository.countClosedByDateRange(start, end),
        this.positionRepository.sumClosedEdgeByDateRange(start, end),
      ]);

    const uptimeSeconds = Math.floor(process.uptime());
    const uptimeHours = Math.floor(uptimeSeconds / 3600);

    return {
      totalTrades,
      totalPnl,
      openPositions,
      closedPositions,
      opportunitiesDetected:
        metrics.eventCounts['detection.opportunity.identified'] ?? 0,
      opportunitiesExecuted: metrics.eventCounts['execution.order.filled'] ?? 0,
      singleLegEvents:
        metrics.eventCounts['execution.single_leg.exposure'] ?? 0,
      riskLimitEvents:
        (metrics.eventCounts['risk.limit.breached'] ?? 0) +
        (metrics.eventCounts['risk.limit.approached'] ?? 0),
      systemHealthSummary: `${uptimeHours}h uptime, ${metrics.errorsCount} handler errors`,
    };
  }

  private formatSummaryRow(dateStr: string, summary: DailySummaryData): string {
    return [
      dateStr,
      String(summary.totalTrades),
      summary.totalPnl,
      String(summary.openPositions),
      String(summary.closedPositions),
      String(summary.opportunitiesDetected),
      String(summary.opportunitiesExecuted),
      String(summary.singleLegEvents),
      String(summary.riskLimitEvents),
      escapeCsvField(summary.systemHealthSummary),
    ].join(',');
  }

  private formatTelegramMessage(
    dateStr: string,
    summary: DailySummaryData,
  ): string {
    return [
      `\u{1F7E2} <b>Daily Summary — ${escapeHtml(dateStr)}</b>`,
      '',
      `Trades: <code>${summary.totalTrades}</code>`,
      `P&amp;L: <code>${escapeHtml(summary.totalPnl)}</code>`,
      `Open: <code>${summary.openPositions}</code> | Closed: <code>${summary.closedPositions}</code>`,
      '',
      `Opportunities: <code>${summary.opportunitiesDetected}</code> detected, <code>${summary.opportunitiesExecuted}</code> executed`,
      `Single-leg: <code>${summary.singleLegEvents}</code> | Risk events: <code>${summary.riskLimitEvents}</code>`,
      '',
      `System: <code>${escapeHtml(summary.systemHealthSummary)}</code>`,
    ].join('\n');
  }
}

interface DailySummaryData {
  totalTrades: number;
  totalPnl: string;
  openPositions: number;
  closedPositions: number;
  opportunitiesDetected: number;
  opportunitiesExecuted: number;
  singleLegEvents: number;
  riskLimitEvents: number;
  systemHealthSummary: string;
}
