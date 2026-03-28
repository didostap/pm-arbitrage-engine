import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  HttpCode,
  Logger,
  ParseUUIDPipe,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ParseIntPipe,
  DefaultValuePipe,
  ValidationPipe,
} from '@nestjs/common';
import {
  BACKTEST_ENGINE_TOKEN,
  type IBacktestEngine,
} from '../../../common/interfaces/backtest-engine.interface';
import { PrismaService } from '../../../common/prisma.service';
import { BacktestConfigDto } from '../dto/backtest-config.dto';
import { SweepConfigDto } from '../dto/calibration-report.dto';
import { SensitivityAnalysisService } from '../reporting/sensitivity-analysis.service';

const MAX_LIST_LIMIT = 100;
const DEFAULT_POSITION_LIMIT = 100;

@Controller('backtesting/runs')
export class BacktestController {
  private readonly logger = new Logger(BacktestController.name);

  constructor(
    @Inject(BACKTEST_ENGINE_TOKEN)
    private readonly engine: IBacktestEngine,
    private readonly prisma: PrismaService,
    private readonly sensitivityService: SensitivityAnalysisService,
  ) {}

  @Post()
  @HttpCode(202)
  async createRun(
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    config: BacktestConfigDto,
  ) {
    // Controller-level validations (beyond class-validator)
    if (new Date(config.dateRangeStart) >= new Date(config.dateRangeEnd)) {
      throw new BadRequestException(
        'dateRangeStart must be before dateRangeEnd',
      );
    }
    if (
      config.tradingWindowStartHour !== undefined &&
      config.tradingWindowEndHour !== undefined &&
      config.tradingWindowStartHour === config.tradingWindowEndHour
    ) {
      throw new BadRequestException(
        'tradingWindowStartHour must differ from tradingWindowEndHour',
      );
    }

    const runId = await this.engine.startRun(config);
    return {
      data: { runId },
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  async listRuns(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('status') status?: string,
  ) {
    const safeLimitValue = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
    const safeOffset = Math.max(offset, 0);

    const where = status ? { status: status as never } : {};

    const [runs, count] = await Promise.all([
      this.prisma.backtestRun.findMany({
        where,
        take: safeLimitValue,
        skip: safeOffset,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.backtestRun.count({ where }),
    ]);

    return {
      data: runs,
      count,
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id')
  async getRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(
      'positionLimit',
      new DefaultValuePipe(DEFAULT_POSITION_LIMIT),
      ParseIntPipe,
    )
    positionLimit: number,
    @Query('positionOffset', new DefaultValuePipe(0), ParseIntPipe)
    positionOffset: number,
  ) {
    const safePositionLimit = Math.min(
      Math.max(positionLimit, 1),
      MAX_LIST_LIMIT,
    );
    const safePositionOffset = Math.max(positionOffset, 0);

    const run = await this.prisma.backtestRun.findUnique({
      where: { id },
      include: {
        positions: {
          take: safePositionLimit,
          skip: safePositionOffset,
          orderBy: { entryTimestamp: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Backtest run ${id} not found`);
    }

    const positionCount = await this.prisma.backtestPosition.count({
      where: { runId: id },
    });

    return {
      data: { ...run, positionCount },
      timestamp: new Date().toISOString(),
    };
  }

  @Delete(':id')
  async cancelRun(@Param('id', ParseUUIDPipe) id: string) {
    const status = this.engine.getRunStatus(id);
    if (!status) {
      throw new NotFoundException(`Backtest run ${id} not found or not active`);
    }

    await this.engine.cancelRun(id);
    return {
      data: { cancelled: true },
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id/report')
  async getReport(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.prisma.backtestRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    if (run.status !== 'COMPLETE') {
      throw new BadRequestException(
        `Run ${id} has status ${run.status}, expected COMPLETE`,
      );
    }
    if (!run.report) {
      throw new NotFoundException(`Report not yet generated for run ${id}`);
    }
    return { data: run.report, timestamp: new Date().toISOString() };
  }

  @Post(':id/sensitivity')
  @HttpCode(202)
  async triggerSensitivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    config?: SweepConfigDto,
  ) {
    const run = await this.prisma.backtestRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    if (run.status !== 'COMPLETE') {
      throw new BadRequestException(
        `Run ${id} has status ${run.status}, expected COMPLETE`,
      );
    }

    // Synchronous concurrency guard before fire-and-forget
    if (this.sensitivityService.isInProgress(id)) {
      throw new ConflictException(
        `Sensitivity sweep already in progress for run ${id}`,
      );
    }

    // Fire-and-forget — results will be persisted asynchronously
    this.sensitivityService.runSweep(id, config).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Sensitivity sweep failed for run ${id}: ${msg}`);
    });

    return {
      data: { runId: id, status: 'STARTED' },
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id/sensitivity')
  async getSensitivity(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.prisma.backtestRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    if (!run.sensitivityResults) {
      throw new NotFoundException(
        `Sensitivity results not yet available for run ${id}`,
      );
    }
    return {
      data: run.sensitivityResults,
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id/walk-forward')
  async getWalkForward(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.prisma.backtestRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    if (!run.walkForwardResults) {
      throw new NotFoundException(
        `Walk-forward results not available for run ${id}`,
      );
    }
    return {
      data: run.walkForwardResults,
      timestamp: new Date().toISOString(),
    };
  }
}
