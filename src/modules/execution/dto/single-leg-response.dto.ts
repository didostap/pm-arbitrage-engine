import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PnlScenariosDto {
  @ApiProperty({ description: 'Estimated PnL if closing now' })
  closeNowEstimate!: string;

  @ApiProperty({ description: 'Estimated PnL if retrying at current price' })
  retryAtCurrentPrice!: string;

  @ApiProperty({ description: 'Risk assessment for holding' })
  holdRiskAssessment!: string;
}

export class RetryLegResultDto {
  @ApiProperty({ description: 'Whether the retry was successful' })
  success!: boolean;

  @ApiPropertyOptional({ description: 'Order ID of the retry order' })
  orderId?: string;

  @ApiPropertyOptional({ description: 'New edge after retry' })
  newEdge?: number;

  @ApiPropertyOptional({ description: 'Reason if retry failed' })
  reason?: string;

  @ApiPropertyOptional({ type: PnlScenariosDto })
  pnlScenarios?: PnlScenariosDto;

  @ApiPropertyOptional({
    description: 'Recommended follow-up actions',
    type: [String],
  })
  recommendedActions?: string[];
}

export class RetryLegResponseDto {
  @ApiProperty({ type: RetryLegResultDto })
  data!: RetryLegResultDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class CloseLegResultDto {
  @ApiProperty({ description: 'Whether the close was successful' })
  success!: boolean;

  @ApiPropertyOptional({ description: 'Order ID of the close order' })
  closeOrderId?: string;

  @ApiPropertyOptional({ description: 'Realized PnL from closing' })
  realizedPnl?: string;

  @ApiPropertyOptional({ description: 'Reason if close failed' })
  reason?: string;
}

export class CloseLegResponseDto {
  @ApiProperty({ type: CloseLegResultDto })
  data!: CloseLegResultDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
