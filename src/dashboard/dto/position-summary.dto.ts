import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PositionSummaryDto {
  @ApiProperty({ description: 'Position ID' })
  id!: string;

  @ApiProperty({ description: 'Contract pair name', example: 'BTC-100K-YES' })
  pairName!: string;

  @ApiProperty({
    description: 'Platforms involved',
    example: { kalshi: 'kalshi', polymarket: 'polymarket' },
  })
  platforms!: { kalshi: string; polymarket: string };

  @ApiProperty({
    description: 'Entry prices per platform (decimal strings)',
    example: { kalshi: '0.55', polymarket: '0.45' },
  })
  entryPrices!: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Current prices per platform (decimal strings, null if unavailable)',
  })
  currentPrices!: Record<string, string> | null;

  @ApiProperty({
    description: 'Initial edge at entry (decimal string)',
    example: '0.012',
  })
  initialEdge!: string;

  @ApiPropertyOptional({
    description: 'Current edge (decimal string, null if unavailable)',
  })
  currentEdge!: string | null;

  @ApiPropertyOptional({
    description: 'Unrealized P&L in USD (decimal string, null if unavailable)',
  })
  unrealizedPnl!: string | null;

  @ApiPropertyOptional({ description: 'Proximity to exit threshold (0-1)' })
  exitProximity!: number | null;

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
}
