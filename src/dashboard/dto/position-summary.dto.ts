import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlatformPairDto {
  @ApiProperty({
    description: 'Kalshi contract ID',
    example: 'kalshi-contract-1',
  })
  kalshi!: string;

  @ApiProperty({
    description: 'Polymarket contract ID',
    example: 'polymarket-contract-1',
  })
  polymarket!: string;
}

export class EntryPricesDto {
  @ApiProperty({
    description: 'Kalshi entry price (decimal string)',
    example: '0.55',
  })
  kalshi!: string;

  @ApiProperty({
    description: 'Polymarket entry price (decimal string)',
    example: '0.45',
  })
  polymarket!: string;
}

export class CurrentPricesDto {
  @ApiPropertyOptional({
    description: 'Kalshi close price (decimal string, null if unavailable)',
    example: '0.60',
    type: String,
    nullable: true,
  })
  kalshi!: string | null;

  @ApiPropertyOptional({
    description: 'Polymarket close price (decimal string, null if unavailable)',
    example: '0.40',
    type: String,
    nullable: true,
  })
  polymarket!: string | null;
}

export class ExitProximityDto {
  @ApiProperty({
    description: 'Stop-loss proximity (decimal string, 0-1 range)',
    example: '0.25000000',
  })
  stopLoss!: string;

  @ApiProperty({
    description: 'Take-profit proximity (decimal string, 0-1 range)',
    example: '0.80000000',
  })
  takeProfit!: string;
}

export class PositionSummaryDto {
  @ApiProperty({ description: 'Position ID' })
  id!: string;

  @ApiProperty({ description: 'Contract match pair ID' })
  pairId!: string;

  @ApiProperty({ description: 'Contract pair name', example: 'BTC-100K-YES' })
  pairName!: string;

  @ApiProperty({ description: 'Platforms involved', type: PlatformPairDto })
  platforms!: PlatformPairDto;

  @ApiProperty({
    description: 'Entry prices per platform (decimal strings)',
    type: EntryPricesDto,
  })
  entryPrices!: EntryPricesDto;

  @ApiPropertyOptional({
    description:
      'Current prices per platform (decimal strings, null if unavailable)',
    type: CurrentPricesDto,
    nullable: true,
  })
  currentPrices!: CurrentPricesDto | null;

  @ApiProperty({
    description: 'Initial edge at entry (decimal string)',
    example: '0.012',
  })
  initialEdge!: string;

  @ApiPropertyOptional({
    description: 'Current edge (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  currentEdge!: string | null;

  @ApiPropertyOptional({
    description: 'Unrealized P&L in USD (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  unrealizedPnl!: string | null;

  @ApiPropertyOptional({
    description:
      'Exit proximity: stop-loss and take-profit as decimal strings (0-1 range)',
    type: ExitProximityDto,
    nullable: true,
  })
  exitProximity!: ExitProximityDto | null;

  @ApiPropertyOptional({
    description: 'Resolution date (ISO 8601, null if unknown)',
    type: String,
    nullable: true,
  })
  resolutionDate!: string | null;

  @ApiPropertyOptional({
    description:
      'Time to resolution (human-readable, e.g., "2d 5h", null if unknown)',
    type: String,
    nullable: true,
  })
  timeToResolution!: string | null;

  @ApiProperty({ description: 'Whether this is a paper trading position' })
  isPaper!: boolean;

  @ApiProperty({
    description: 'Position status',
    enum: [
      'OPEN',
      'SINGLE_LEG_EXPOSED',
      'EXIT_PARTIAL',
      'CLOSED',
      'RECONCILIATION_REQUIRED',
    ],
  })
  status!: string;

  @ApiPropertyOptional({
    description:
      'Realized P&L in USD for closed positions (decimal string, null for open)',
    type: String,
    nullable: true,
  })
  realizedPnl!: string | null;

  @ApiPropertyOptional({
    description: 'Exit type for closed positions (null for open)',
    enum: ['stop_loss', 'take_profit', 'time_based', 'manual'],
    nullable: true,
  })
  exitType!: string | null;

  @ApiPropertyOptional({
    description:
      'Projected P&L at stop-loss threshold (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  projectedSlPnl!: string | null;

  @ApiPropertyOptional({
    description:
      'Projected P&L at take-profit threshold (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  projectedTpPnl!: string | null;
}
