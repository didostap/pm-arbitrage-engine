import { ApiProperty } from '@nestjs/swagger';

export class AlertSummaryDto {
  @ApiProperty({ description: 'Alert ID' })
  id!: string;

  @ApiProperty({
    description: 'Alert type',
    enum: [
      'single_leg_exposure',
      'risk_limit_breached',
      'risk_limit_approached',
    ],
  })
  type!: string;

  @ApiProperty({
    description: 'Alert severity',
    enum: ['critical', 'warning', 'info'],
  })
  severity!: string;

  @ApiProperty({ description: 'Human-readable alert message' })
  message!: string;

  @ApiProperty({ description: 'Alert timestamp (ISO 8601)' })
  timestamp!: string;

  @ApiProperty({
    description: 'Whether the alert has been acknowledged by operator',
  })
  acknowledged!: boolean;
}
