import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AlertSummaryDto {
  @ApiProperty({ description: 'Alert ID' })
  id!: string;

  @ApiProperty({
    description: 'Alert type',
    enum: [
      'single_leg_exposure',
      'risk_limit_breached',
      'risk_limit_approached',
      'auto_unwind',
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

  @ApiPropertyOptional({
    description: 'Position ID associated with this alert',
    type: String,
    nullable: true,
  })
  positionId?: string | null;

  @ApiPropertyOptional({
    description: 'Whether auto-unwind will be attempted for this exposure',
  })
  autoUnwindAttempted?: boolean;

  @ApiPropertyOptional({
    description: 'Auto-unwind action taken',
    type: String,
    nullable: true,
  })
  autoUnwindAction?: string | null;

  @ApiPropertyOptional({
    description: 'Auto-unwind result',
    type: String,
    nullable: true,
  })
  autoUnwindResult?: string | null;
}
