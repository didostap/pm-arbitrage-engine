import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IngestionOrchestratorService } from '../ingestion/ingestion-orchestrator.service';
import { PrismaService } from '../../../common/prisma.service';
import { IngestionTriggerDto } from '../dto/ingestion-trigger.dto';

@Controller('api/backtesting')
export class HistoricalDataController {
  private readonly logger = new Logger(HistoricalDataController.name);

  constructor(
    private readonly orchestrator: IngestionOrchestratorService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('ingest')
  @HttpCode(202)
  triggerIngestion(@Body() dto: IngestionTriggerDto) {
    const start = new Date(dto.dateRangeStart);
    const end = new Date(dto.dateRangeEnd);

    // P9: Validate date range ordering
    if (start >= end) {
      throw new BadRequestException(
        'dateRangeStart must be before dateRangeEnd',
      );
    }

    // P6: Reject if already running
    if (this.orchestrator.isRunning) {
      throw new ConflictException('Ingestion already in progress');
    }

    // Fire and forget — ingestion runs asynchronously
    this.orchestrator
      .runIngestion({
        dateRangeStart: start,
        dateRangeEnd: end,
      })
      .catch((error: unknown) => {
        // P7: Log top-level failures instead of swallowing silently
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Ingestion run failed: ${msg}`);
      });

    // P19: Removed runId — it was never tracked or queryable
    return {
      data: { status: 'accepted' },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('coverage')
  async getCoverage() {
    const [priceCoverage, tradeCoverage, depthCoverage] = await Promise.all([
      this.prisma.historicalPrice.groupBy({
        by: ['platform', 'contractId'],
        _count: { id: true },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
      this.prisma.historicalTrade.groupBy({
        by: ['platform', 'contractId'],
        _count: { id: true },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
      this.prisma.historicalDepth.groupBy({
        by: ['platform', 'contractId', 'source'],
        _count: { id: true },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
    ]);

    const data = [
      ...priceCoverage.map((p) => ({
        type: 'price',
        platform: p.platform,
        contractId: p.contractId,
        count: p._count.id,
        minTimestamp: p._min.timestamp,
        maxTimestamp: p._max.timestamp,
      })),
      ...tradeCoverage.map((t) => ({
        type: 'trade',
        platform: t.platform,
        contractId: t.contractId,
        count: t._count.id,
        minTimestamp: t._min.timestamp,
        maxTimestamp: t._max.timestamp,
      })),
      ...depthCoverage.map((d) => ({
        type: 'depth',
        platform: d.platform,
        contractId: d.contractId,
        source: d.source,
        count: d._count.id,
        minTimestamp: d._min.timestamp,
        maxTimestamp: d._max.timestamp,
      })),
    ];

    return {
      data,
      count: data.length,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('coverage/:contractId')
  async getContractCoverage(@Param('contractId') contractId: string) {
    const [
      priceCount,
      priceRange,
      tradeCount,
      tradeRange,
      depthCount,
      depthRange,
      depthFreshness,
    ] = await Promise.all([
      this.prisma.historicalPrice.count({
        where: { contractId },
      }),
      this.prisma.historicalPrice.aggregate({
        where: { contractId },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
      this.prisma.historicalTrade.count({
        where: { contractId },
      }),
      this.prisma.historicalTrade.aggregate({
        where: { contractId },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
      this.prisma.historicalDepth.count({
        where: { contractId },
      }),
      this.prisma.historicalDepth.aggregate({
        where: { contractId },
        _min: { timestamp: true },
        _max: { timestamp: true },
      }),
      this.prisma.historicalDepth.groupBy({
        by: ['source'],
        where: { contractId },
        _max: { timestamp: true },
      }),
    ]);

    const freshness: Record<string, Date | null> = {};
    for (const row of depthFreshness) {
      freshness[row.source] = row._max.timestamp;
    }

    return {
      data: {
        contractId,
        prices: {
          count: priceCount,
          minTimestamp: priceRange._min.timestamp,
          maxTimestamp: priceRange._max.timestamp,
        },
        trades: {
          count: tradeCount,
          minTimestamp: tradeRange._min.timestamp,
          maxTimestamp: tradeRange._max.timestamp,
        },
        depth: {
          count: depthCount,
          minTimestamp: depthRange._min.timestamp,
          maxTimestamp: depthRange._max.timestamp,
        },
        freshness,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
