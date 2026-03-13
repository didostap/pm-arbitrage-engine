import { ApiProperty } from '@nestjs/swagger';

export class StressTestResultDto {
  @ApiProperty({
    description: 'Timestamp of the stress test run (ISO 8601)',
    type: String,
  })
  runTimestamp!: string;

  @ApiProperty({
    description: 'Total scenarios simulated (random + synthetic)',
  })
  numScenarios!: number;

  @ApiProperty({ description: 'Number of open positions simulated' })
  numPositions!: number;

  @ApiProperty({ description: 'Bankroll used for simulation', type: String })
  bankrollUsd!: string;

  @ApiProperty({
    description: 'Value at Risk at 95% confidence (USD)',
    type: String,
  })
  var95!: string;

  @ApiProperty({
    description: 'Value at Risk at 99% confidence (USD)',
    type: String,
  })
  var99!: string;

  @ApiProperty({
    description: 'Maximum loss across all scenarios (USD)',
    type: String,
  })
  worstCaseLoss!: string;

  @ApiProperty({ description: 'P(drawdown > 15%)', type: String })
  drawdown15PctProbability!: string;

  @ApiProperty({ description: 'P(drawdown > 20%)', type: String })
  drawdown20PctProbability!: string;

  @ApiProperty({ description: 'P(drawdown > 25%)', type: String })
  drawdown25PctProbability!: string;

  @ApiProperty({ description: 'Whether a risk alert was emitted' })
  alertEmitted!: boolean;

  @ApiProperty({
    description: 'Parameter tightening suggestions',
    type: [String],
  })
  suggestions!: string[];

  @ApiProperty({ description: 'Detailed scenario statistics' })
  scenarioDetails!: {
    percentiles: Record<string, string>;
    syntheticResults: { name: string; portfolioPnl: string }[];
    volatilities: {
      contractId: string;
      platform: string;
      vol: string;
      source: string;
    }[];
  };
}

export class StressTestResponseDto {
  @ApiProperty({ type: StressTestResultDto })
  data!: StressTestResultDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class StressTestTriggerResponseDto {
  @ApiProperty({ type: StressTestResultDto })
  data!: StressTestResultDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
