import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ModeCapitalDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  bankroll!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  deployed!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  available!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  reserved!: string | null;
}

export class CapitalOverviewDto {
  @ApiProperty({ type: ModeCapitalDto })
  live!: ModeCapitalDto;

  @ApiProperty({ type: ModeCapitalDto })
  paper!: ModeCapitalDto;
}

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

  @ApiProperty({
    description: 'Whether live trading is currently halted',
    example: false,
  })
  tradingHalted!: boolean;

  @ApiProperty({
    description: 'Active halt reasons (empty when not halted)',
    example: ['daily_loss_limit'],
    type: [String],
  })
  haltReasons!: string[];

  @ApiPropertyOptional({
    description: 'Per-mode capital breakdown (live and paper)',
    type: CapitalOverviewDto,
    nullable: true,
  })
  capitalOverview!: CapitalOverviewDto | null;

  // Flat convenience fields — resolve to live-mode values for dashboard display
  @ApiPropertyOptional({
    description: 'Live-mode total bankroll (decimal string)',
    type: String,
    nullable: true,
  })
  totalBankroll!: string | null;

  @ApiPropertyOptional({
    description: 'Live-mode deployed capital (decimal string)',
    type: String,
    nullable: true,
  })
  deployedCapital!: string | null;

  @ApiPropertyOptional({
    description: 'Live-mode available capital (decimal string)',
    type: String,
    nullable: true,
  })
  availableCapital!: string | null;

  @ApiPropertyOptional({
    description: 'Live-mode reserved capital (decimal string)',
    type: String,
    nullable: true,
  })
  reservedCapital!: string | null;
}
