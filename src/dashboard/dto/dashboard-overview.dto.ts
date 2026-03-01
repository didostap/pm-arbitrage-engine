import { ApiProperty } from '@nestjs/swagger';

export class DashboardOverviewDto {
  @ApiProperty({
    description: 'Composite system health status',
    enum: ['healthy', 'degraded', 'critical'],
  })
  systemHealth!: 'healthy' | 'degraded' | 'critical';

  @ApiProperty({
    description: 'Trailing 7-day P&L in USD (decimal string)',
    example: '125.50',
  })
  trailingPnl7d!: string;

  @ApiProperty({
    description: 'Execution quality ratio (successful / total)',
    example: 0.95,
  })
  executionQualityRatio!: number;

  @ApiProperty({ description: 'Number of currently open positions' })
  openPositionCount!: number;

  @ApiProperty({ description: 'Number of active (unacknowledged) alerts' })
  activeAlertCount!: number;
}
