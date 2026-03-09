import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({
    description: 'Total bankroll from engine config (decimal string)',
    type: String,
    nullable: true,
  })
  totalBankroll!: string | null;

  @ApiPropertyOptional({
    description:
      'Capital currently deployed in open positions (decimal string)',
    type: String,
    nullable: true,
  })
  deployedCapital!: string | null;

  @ApiPropertyOptional({
    description:
      'Available capital: bankroll - deployed - reserved (decimal string)',
    type: String,
    nullable: true,
  })
  availableCapital!: string | null;

  @ApiPropertyOptional({
    description: 'Capital reserved for pending executions (decimal string)',
    type: String,
    nullable: true,
  })
  reservedCapital!: string | null;
}
