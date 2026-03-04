import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

// ── Query DTOs ──────────────────────────────────────────────────────────────

export enum PerformanceMode {
  LIVE = 'live',
  PAPER = 'paper',
}

export class WeeklyQueryDto {
  @ApiPropertyOptional({ default: 8, minimum: 1, maximum: 52 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  weeks?: number;

  @ApiPropertyOptional({ enum: PerformanceMode })
  @IsOptional()
  @IsEnum(PerformanceMode)
  mode?: PerformanceMode;
}

export class DailyQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({ enum: PerformanceMode })
  @IsOptional()
  @IsEnum(PerformanceMode)
  mode?: PerformanceMode;
}

export class TrendsQueryDto {
  @ApiPropertyOptional({ enum: PerformanceMode })
  @IsOptional()
  @IsEnum(PerformanceMode)
  mode?: PerformanceMode;
}

// ── Response DTOs ───────────────────────────────────────────────────────────

export class WeeklySummaryDto {
  @ApiProperty({ description: 'ISO date, Monday 00:00:00.000 UTC' })
  weekStart!: string;

  @ApiProperty({
    description:
      'ISO date, following Monday 00:00:00.000 UTC (exclusive upper bound)',
  })
  weekEnd!: string;

  @ApiProperty({ description: 'Count of filled orders in range' })
  totalTrades!: number;

  @ApiProperty({ description: 'Count of closed positions in range' })
  closedPositions!: number;

  @ApiProperty({
    description: 'Sum of expectedEdge on closed positions (Decimal string)',
  })
  pnl!: string;

  @ApiProperty({
    description:
      'Profitable closed positions / total closed. 0 if no closed positions.',
  })
  hitRate!: number;

  @ApiProperty({
    description:
      'Average |fillPrice - price| on filled orders (Decimal string)',
  })
  averageSlippage!: string;

  @ApiProperty({ description: 'Count of OPPORTUNITY_IDENTIFIED audit entries' })
  opportunitiesDetected!: number;

  @ApiProperty({ description: 'Count of OPPORTUNITY_FILTERED audit entries' })
  opportunitiesFiltered!: number;

  @ApiProperty({ description: 'Count of ORDER_FILLED audit entries' })
  opportunitiesExecuted!: number;

  @ApiProperty({
    description: 'Count of approved risk overrides in range',
  })
  manualInterventions!: number;

  @ApiProperty({
    description:
      'totalTrades / max(manualInterventions, 1). "N/A" if zero trades.',
  })
  autonomyRatio!: string;
}

export class DailyPerformanceDto {
  @ApiProperty({ description: 'ISO date (YYYY-MM-DD)' })
  date!: string;

  @ApiProperty({ description: 'Count of filled orders in range' })
  totalTrades!: number;

  @ApiProperty({ description: 'Count of closed positions in range' })
  closedPositions!: number;

  @ApiProperty({
    description: 'Sum of expectedEdge on closed positions (Decimal string)',
  })
  pnl!: string;

  @ApiProperty({
    description:
      'Profitable closed positions / total closed. 0 if no closed positions.',
  })
  hitRate!: number;

  @ApiProperty({
    description:
      'Average |fillPrice - price| on filled orders (Decimal string)',
  })
  averageSlippage!: string;

  @ApiProperty({ description: 'Count of OPPORTUNITY_IDENTIFIED audit entries' })
  opportunitiesDetected!: number;

  @ApiProperty({ description: 'Count of OPPORTUNITY_FILTERED audit entries' })
  opportunitiesFiltered!: number;

  @ApiProperty({ description: 'Count of ORDER_FILLED audit entries' })
  opportunitiesExecuted!: number;

  @ApiProperty({
    description: 'Count of approved risk overrides in range',
  })
  manualInterventions!: number;

  @ApiProperty({
    description:
      'totalTrades / max(manualInterventions, 1). "N/A" if zero trades.',
  })
  autonomyRatio!: string;
}

export class RollingAverageDto {
  @ApiProperty({ description: '4-week avg opportunity frequency per week' })
  opportunityFrequency!: number;

  @ApiProperty({
    description: '4-week avg edge captured per week (Decimal string)',
  })
  edgeCaptured!: string;

  @ApiProperty({ description: '4-week avg slippage per week (Decimal string)' })
  slippage!: string;
}

export class PerformanceTrendsDto {
  @ApiProperty({ type: RollingAverageDto })
  rollingAverages!: RollingAverageDto;

  @ApiProperty({
    description: 'True if latest 4-week avg opportunity count < 8 per week',
  })
  opportunityBelowBaseline!: boolean;

  @ApiProperty({
    enum: ['improving', 'stable', 'declining'],
    description:
      'Compare latest 4-week avg PnL to previous 4-week avg (10% threshold)',
  })
  edgeTrend!: 'improving' | 'stable' | 'declining';

  @ApiProperty({ type: WeeklySummaryDto })
  latestWeekSummary!: WeeklySummaryDto;

  @ApiProperty({
    description:
      'True when fewer than 8 weeks of non-empty data exist, making trend analysis unreliable',
  })
  dataInsufficient!: boolean;
}

// ── Response Wrappers ───────────────────────────────────────────────────────

export class WeeklyListResponseDto {
  @ApiProperty({ type: [WeeklySummaryDto] })
  data!: WeeklySummaryDto[];

  @ApiProperty()
  count!: number;

  @ApiProperty()
  timestamp!: string;
}

export class DailyListResponseDto {
  @ApiProperty({ type: [DailyPerformanceDto] })
  data!: DailyPerformanceDto[];

  @ApiProperty()
  count!: number;

  @ApiProperty()
  timestamp!: string;
}

export class TrendsResponseDto {
  @ApiProperty({ type: PerformanceTrendsDto })
  data!: PerformanceTrendsDto;

  @ApiProperty()
  timestamp!: string;
}
