import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RiskDecisionDto {
  @ApiProperty({ description: 'Whether the override was approved' })
  approved!: boolean;

  @ApiProperty({ description: 'Reason for the decision' })
  reason!: string;

  @ApiProperty({
    description: 'Maximum position size in USD',
    type: String,
    example: '150.00',
  })
  maxPositionSizeUsd!: string;

  @ApiProperty({ description: 'Current number of open pairs' })
  currentOpenPairs!: number;

  @ApiPropertyOptional({
    description: 'Daily PnL in USD',
    type: String,
    example: '-12.50',
  })
  dailyPnl?: string;

  @ApiPropertyOptional({ description: 'Whether an override was applied' })
  overrideApplied?: boolean;

  @ApiPropertyOptional({ description: 'Rationale for the override' })
  overrideRationale?: string;
}

export class RiskOverrideResponseDto {
  @ApiProperty({ type: RiskDecisionDto })
  data!: RiskDecisionDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
