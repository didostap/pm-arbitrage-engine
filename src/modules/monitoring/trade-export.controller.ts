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
import { AuthTokenGuard } from '../../common/guards/auth-token.guard.js';

/** Minimal Fastify reply interface — avoids direct fastify dependency. */
interface Reply {
  header(name: string, value: string): this;
  status(code: number): this;
  send(payload?: unknown): this;
}
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { TradeExportQueryDto } from './dto/trade-export-query.dto.js';
import { escapeCsvField, getCsvHeader } from './csv-trade-log.service.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

const MAX_RANGE_DAYS = 90;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

@Controller('api/exports')
@UseGuards(AuthTokenGuard)
export class TradeExportController {
  private readonly logger = new Logger(TradeExportController.name);
  private rateLimitEntries: number[] = [];

  constructor(private readonly orderRepository: OrderRepository) {}

  @Get('trades')
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
          code: 400,
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
