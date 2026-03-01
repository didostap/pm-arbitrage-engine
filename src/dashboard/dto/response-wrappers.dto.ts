import { ApiProperty } from '@nestjs/swagger';
import { DashboardOverviewDto } from './dashboard-overview.dto';
import { PlatformHealthDto } from './platform-health.dto';
import { PositionSummaryDto } from './position-summary.dto';
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

export class PositionListResponseDto {
  @ApiProperty({ type: [PositionSummaryDto] })
  data!: PositionSummaryDto[];

  @ApiProperty({ description: 'Number of items' })
  count!: number;

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
