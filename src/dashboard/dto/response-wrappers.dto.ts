import { ApiProperty } from '@nestjs/swagger';
import { DashboardOverviewDto } from './dashboard-overview.dto';
import { PlatformHealthDto } from './platform-health.dto';
import { PositionSummaryDto } from './position-summary.dto';
import { PositionFullDetailDto } from './position-detail.dto';
import { AlertSummaryDto } from './alert-summary.dto';

export class OverviewResponseDto {
  @ApiProperty({ type: DashboardOverviewDto })
  data!: DashboardOverviewDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class HealthListResponseDto {
  @ApiProperty({ type: [PlatformHealthDto] })
  data!: PlatformHealthDto[];

  @ApiProperty({ description: 'Number of items' })
  count!: number;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class PositionDetailResponseDto {
  @ApiProperty({ type: PositionSummaryDto })
  data!: PositionSummaryDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class PositionListResponseDto {
  @ApiProperty({ type: [PositionSummaryDto] })
  data!: PositionSummaryDto[];

  @ApiProperty({ description: 'Total number of matching positions' })
  count!: number;

  @ApiProperty({ description: 'Current page number' })
  page!: number;

  @ApiProperty({ description: 'Items per page' })
  limit!: number;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class PositionFullDetailResponseDto {
  @ApiProperty({ type: PositionFullDetailDto })
  data!: PositionFullDetailDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class AlertListResponseDto {
  @ApiProperty({ type: [AlertSummaryDto] })
  data!: AlertSummaryDto[];

  @ApiProperty({ description: 'Number of items' })
  count!: number;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
