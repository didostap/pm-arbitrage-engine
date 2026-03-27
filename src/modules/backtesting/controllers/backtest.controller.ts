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
  ParseUUIDPipe,
  BadRequestException,
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

const MAX_LIST_LIMIT = 100;
const DEFAULT_POSITION_LIMIT = 100;

@Controller('backtesting/runs')
export class BacktestController {
  constructor(
    @Inject(BACKTEST_ENGINE_TOKEN)
    private readonly engine: IBacktestEngine,
    private readonly prisma: PrismaService,
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
  ) {
    const safeLimitValue = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
    const safeOffset = Math.max(offset, 0);

    const [runs, count] = await Promise.all([
      this.prisma.backtestRun.findMany({
        take: safeLimitValue,
        skip: safeOffset,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.backtestRun.count(),
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
}
