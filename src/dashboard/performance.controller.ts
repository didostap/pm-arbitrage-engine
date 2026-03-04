import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { PerformanceService } from './performance.service';
import {
  WeeklyListResponseDto,
  DailyListResponseDto,
  TrendsResponseDto,
  WeeklyQueryDto,
  DailyQueryDto,
  TrendsQueryDto,
} from './dto/performance.dto';

@Controller('performance')
@UseGuards(AuthTokenGuard)
@ApiTags('Performance')
@ApiBearerAuth()
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Get('weekly')
  @ApiOperation({ summary: 'Weekly performance summaries' })
  @ApiResponse({ status: 200, type: WeeklyListResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async getWeekly(
    @Query() query: WeeklyQueryDto,
  ): Promise<WeeklyListResponseDto> {
    const weeks = query.weeks ?? 8;
    const data = await this.performanceService.getWeeklySummary(
      weeks,
      query.mode,
    );
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }

  @Get('daily')
  @ApiOperation({ summary: 'Daily performance summaries' })
  @ApiResponse({ status: 200, type: DailyListResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async getDaily(@Query() query: DailyQueryDto): Promise<DailyListResponseDto> {
    const days = query.days ?? 30;
    const data = await this.performanceService.getDailySummary(
      days,
      query.mode,
    );
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }

  @Get('trends')
  @ApiOperation({ summary: '4-week rolling averages with trend analysis' })
  @ApiResponse({ status: 200, type: TrendsResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async getTrends(@Query() query: TrendsQueryDto): Promise<TrendsResponseDto> {
    const data = await this.performanceService.getRollingAverages(query.mode);
    return { data, timestamp: new Date().toISOString() };
  }
}
