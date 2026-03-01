import {
  Controller,
  Get,
  Logger,
  Query,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard.js';

/** Minimal Fastify reply interface — avoids direct fastify dependency. */
interface Reply {
  header(name: string, value: string): this;
  status(code: number): this;
  send(payload?: unknown): this;
}
import Decimal from 'decimal.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { PositionRepository } from '../../persistence/repositories/position.repository.js';
import { TradeExportQueryDto } from './dto/trade-export-query.dto.js';
import { TaxReportQueryDto } from './dto/tax-report-query.dto.js';
import { escapeCsvField, getCsvHeader } from './csv-trade-log.service.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

const MAX_RANGE_DAYS = 90;
const RATE_LIMIT_MAX = 5;

/** Transaction type categorization per platform (for tax reporting). */
const PLATFORM_TX_TYPE: Record<string, string> = {
  POLYMARKET: 'on-chain',
  KALSHI: 'regulated-exchange',
};
const RATE_LIMIT_WINDOW_MS = 60_000;

@ApiTags('Exports')
@ApiBearerAuth()
@Controller('exports')
@UseGuards(AuthTokenGuard)
export class TradeExportController {
  private readonly logger = new Logger(TradeExportController.name);
  private rateLimitEntries: number[] = [];

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly positionRepository: PositionRepository,
  ) {}

  @Get('trades')
  @ApiOperation({ summary: 'Export trade log (JSON or CSV)' })
  @ApiProduces('application/json', 'text/csv')
  @ApiResponse({
    status: 200,
    description: 'Trade log data (JSON or CSV depending on format query param)',
    schema: { type: 'string' },
  })
  @ApiResponse({ status: 400, description: 'Invalid date range' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async exportTrades(
    @Query() query: TradeExportQueryDto,
    @Res() reply: Reply,
  ): Promise<void> {
    // Rate limit check
    if (this.isRateLimited()) {
      void reply.status(429).send({
        error: {
          code: MONITORING_ERROR_CODES.EXPORT_RATE_LIMIT_EXCEEDED,
          message: 'Export rate limit exceeded — max 5 requests per minute',
          severity: 'warning',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Date range validation
    const startDate = new Date(query.startDate);
    const endDate = new Date(query.endDate);
    const diffDays =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays > MAX_RANGE_DAYS) {
      void reply.status(400).send({
        error: {
          code: MONITORING_ERROR_CODES.INVALID_DATE_RANGE,
          message: `Date range exceeds maximum of ${MAX_RANGE_DAYS} days`,
          severity: 'warning',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const orders = await this.orderRepository.findByDateRange(
        startDate,
        endDate,
      );

      if (query.format === 'csv') {
        const csvContent = this.buildCsvContent(orders);
        void reply
          .header('Content-Type', 'text/csv')
          .header(
            'Content-Disposition',
            `attachment; filename="trades-${query.startDate}-to-${query.endDate}.csv"`,
          )
          .send(csvContent);
        return;
      }

      // JSON format — standard response
      void reply.send({
        data: orders,
        count: orders.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({
        message: 'Trade export failed',
        error: String(error),
        module: 'monitoring',
      });
      void reply.status(500).send({
        error: {
          code: 4000,
          message: 'Internal error exporting trades',
          severity: 'error',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  @Get('tax-report')
  @ApiOperation({ summary: 'Export annual tax report (CSV)' })
  @ApiProduces('text/csv')
  @ApiResponse({
    status: 200,
    description: 'Tax report CSV file',
    schema: { type: 'string' },
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async exportTaxReport(
    @Query() query: TaxReportQueryDto,
    @Res() reply: Reply,
  ): Promise<void> {
    // Shared rate limiter with trades endpoint
    if (this.isRateLimited()) {
      void reply.status(429).send({
        error: {
          code: MONITORING_ERROR_CODES.EXPORT_RATE_LIMIT_EXCEEDED,
          message: 'Export rate limit exceeded — max 5 requests per minute',
          severity: 'warning',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const yearStart = new Date(`${query.year}-01-01T00:00:00Z`);
      const yearEnd = new Date(`${query.year}-12-31T23:59:59.999Z`);

      // Trade log — all orders for the year
      const orders = await this.orderRepository.findByDateRange(
        yearStart,
        yearEnd,
      );

      // Build orderId → positionId lookup for trade log enrichment
      const orderIds = orders.map((o) => o.orderId);
      const positions = await this.positionRepository.findByOrderIds(orderIds);
      const orderToPosition = new Map<string, string>();
      for (const pos of positions) {
        if (pos.kalshiOrderId)
          orderToPosition.set(pos.kalshiOrderId, pos.positionId);
        if (pos.polymarketOrderId)
          orderToPosition.set(pos.polymarketOrderId, pos.positionId);
      }

      // Quarterly P&L by platform
      const quarters = this.buildQuarterRanges(query.year);
      const quarterlyRows: string[] = [];

      let totalKalshiPnl = new Decimal(0);
      let totalPolymarketPnl = new Decimal(0);
      let totalKalshiTrades = 0;
      let totalPolymarketTrades = 0;

      for (const q of quarters) {
        const kalshiEdge =
          await this.positionRepository.sumClosedEdgeByDateRange(
            q.start,
            q.end,
          );
        // MVP simplification: split expectedEdge 50/50 between platforms.
        // In reality each leg has different entry prices so P&L attribution
        // per platform depends on the price differential. A proper per-leg
        // P&L calculation requires a schema migration (Phase 1).
        const halfEdge = new Decimal(kalshiEdge).div(2);

        const kalshiCount =
          await this.positionRepository.countOrdersByPlatformAndDateRange(
            'KALSHI',
            q.start,
            q.end,
          );
        const polyCount =
          await this.positionRepository.countOrdersByPlatformAndDateRange(
            'POLYMARKET',
            q.start,
            q.end,
          );

        totalKalshiPnl = totalKalshiPnl.plus(halfEdge);
        totalPolymarketPnl = totalPolymarketPnl.plus(halfEdge);
        totalKalshiTrades += kalshiCount;
        totalPolymarketTrades += polyCount;

        quarterlyRows.push(
          [
            q.label,
            'KALSHI',
            PLATFORM_TX_TYPE['KALSHI'],
            String(kalshiCount),
            halfEdge.toString(),
          ].join(','),
        );
        quarterlyRows.push(
          [
            q.label,
            'POLYMARKET',
            PLATFORM_TX_TYPE['POLYMARKET'],
            String(polyCount),
            halfEdge.toString(),
          ].join(','),
        );
      }

      // Build CSV
      const sections: string[] = [];

      // Disclaimer
      sections.push(
        '# DISCLAIMER: P&L figures are based on expected edge at trade entry, not realized gains. Consult tax advisor for official filings.',
      );
      sections.push('');

      // Trade log section
      sections.push('# TRADE LOG');
      sections.push(
        'date,platform,transaction_type,contract_id,side,price,size,fill_price,fees,gas,cost_basis,proceeds,pnl,position_id,pair_id,is_paper,correlation_id',
      );
      for (const order of orders) {
        const txType = PLATFORM_TX_TYPE[order.platform] ?? 'unknown';
        const costBasis = new Decimal(order.price.toString()).mul(
          new Decimal(order.size.toString()),
        );
        sections.push(
          [
            escapeCsvField(order.createdAt.toISOString()),
            escapeCsvField(order.platform),
            txType,
            escapeCsvField(order.contractId),
            escapeCsvField(order.side),
            order.price.toString(),
            order.size.toString(),
            order.fillPrice?.toString() ?? '0',
            '0', // fees — not tracked per-order in DB
            '0', // gas — not tracked per-order in DB
            costBasis.toString(),
            'N/A', // proceeds — requires realized P&L tracking (Phase 1 schema migration)
            'N/A', // pnl — per-trade P&L not available; see quarterly summary for expectedEdge proxy
            orderToPosition.get(order.orderId) ?? 'N/A',
            escapeCsvField(order.pairId),
            String(order.isPaper),
            'N/A', // correlationId — Order model does not store correlationId (data model gap)
          ].join(','),
        );
      }

      sections.push('');

      // Quarterly P&L section
      sections.push('# QUARTERLY P&L SUMMARY');
      sections.push('quarter,platform,transaction_type,total_trades,total_pnl');
      sections.push(...quarterlyRows);
      sections.push('');

      // Annual summary
      const totalTrades = totalKalshiTrades + totalPolymarketTrades;
      const totalPnl = totalKalshiPnl.plus(totalPolymarketPnl);
      sections.push('# ANNUAL SUMMARY');
      sections.push(
        'year,total_trades,total_pnl,kalshi_pnl,polymarket_pnl,kalshi_trades,polymarket_trades',
      );
      sections.push(
        [
          String(query.year),
          String(totalTrades),
          totalPnl.toString(),
          totalKalshiPnl.toString(),
          totalPolymarketPnl.toString(),
          String(totalKalshiTrades),
          String(totalPolymarketTrades),
        ].join(','),
      );

      void reply
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="${query.year}-tax-report.csv"`,
        )
        .send(sections.join('\n'));
    } catch (error) {
      this.logger.error({
        message: 'Tax report export failed',
        error: String(error),
        module: 'monitoring',
      });
      void reply.status(500).send({
        error: {
          code: 4000,
          message: 'Internal error generating tax report',
          severity: 'error',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Visible for testing — resets the rate limiter entries. */
  resetRateLimiter(): void {
    this.rateLimitEntries = [];
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    this.rateLimitEntries = this.rateLimitEntries.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    if (this.rateLimitEntries.length >= RATE_LIMIT_MAX) {
      return true;
    }

    this.rateLimitEntries.push(now);
    return false;
  }

  private buildQuarterRanges(
    year: number,
  ): Array<{ label: string; start: Date; end: Date }> {
    return [
      {
        label: `Q1 ${year}`,
        start: new Date(`${year}-01-01T00:00:00Z`),
        end: new Date(`${year}-03-31T23:59:59.999Z`),
      },
      {
        label: `Q2 ${year}`,
        start: new Date(`${year}-04-01T00:00:00Z`),
        end: new Date(`${year}-06-30T23:59:59.999Z`),
      },
      {
        label: `Q3 ${year}`,
        start: new Date(`${year}-07-01T00:00:00Z`),
        end: new Date(`${year}-09-30T23:59:59.999Z`),
      },
      {
        label: `Q4 ${year}`,
        start: new Date(`${year}-10-01T00:00:00Z`),
        end: new Date(`${year}-12-31T23:59:59.999Z`),
      },
    ];
  }

  private buildCsvContent(
    orders: Awaited<ReturnType<OrderRepository['findByDateRange']>>,
  ): string {
    const header = getCsvHeader();
    if (orders.length === 0) return header;

    const rows = orders.map((order) => {
      return [
        escapeCsvField(order.createdAt.toISOString()),
        escapeCsvField(order.platform),
        escapeCsvField(order.contractId),
        escapeCsvField(order.side),
        escapeCsvField(order.price.toString()),
        escapeCsvField(order.size.toString()),
        escapeCsvField(order.fillPrice?.toString() ?? '0'),
        '0', // fees — not tracked per-order in DB
        '0', // gas — not tracked per-order in DB
        '0', // edge — not available per-order
        'N/A', // pnl — computed at position level
        'N/A', // positionId — requires reverse lookup
        escapeCsvField(order.pairId),
        String(order.isPaper),
        'N/A', // correlationId — not stored on Order
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }
}
