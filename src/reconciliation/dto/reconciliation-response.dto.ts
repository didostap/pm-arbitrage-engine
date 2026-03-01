import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// --- resolve ---

export class ResolveDiscrepancyDataDto {
  @ApiProperty()
  success!: boolean;

  @ApiProperty()
  positionId!: string;

  @ApiProperty({ description: 'New position status after resolution' })
  newStatus!: string;

  @ApiProperty({ description: 'Remaining discrepancies for this position' })
  remainingDiscrepancies!: number;
}

export class ResolveDiscrepancyResponseDto {
  @ApiProperty({ type: ResolveDiscrepancyDataDto })
  data!: ResolveDiscrepancyDataDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

// --- run ---

export class ReconciliationDiscrepancyDto {
  @ApiProperty()
  positionId!: string;

  @ApiProperty()
  pairId!: string;

  @ApiProperty({
    enum: [
      'order_status_mismatch',
      'order_not_found',
      'pending_filled',
      'platform_unavailable',
    ],
  })
  discrepancyType!: string;

  @ApiProperty()
  localState!: string;

  @ApiProperty()
  platformState!: string;

  @ApiProperty()
  recommendedAction!: string;
}

export class ReconciliationResultDto {
  @ApiProperty()
  positionsChecked!: number;

  @ApiProperty()
  ordersVerified!: number;

  @ApiProperty()
  pendingOrdersResolved!: number;

  @ApiProperty()
  discrepanciesFound!: number;

  @ApiProperty()
  durationMs!: number;

  @ApiProperty({ type: [String] })
  platformsUnavailable!: string[];

  @ApiProperty({ type: [ReconciliationDiscrepancyDto] })
  discrepancies!: ReconciliationDiscrepancyDto[];
}

export class ReconciliationRunResponseDto {
  @ApiProperty({ type: ReconciliationResultDto })
  data!: ReconciliationResultDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

// --- status ---

export class ReconciliationStatusDataDto {
  @ApiPropertyOptional({
    type: ReconciliationResultDto,
    description: 'Result of the last reconciliation run, or null if none',
    nullable: true,
  })
  lastRun!: ReconciliationResultDto | null;

  @ApiPropertyOptional({
    description: 'ISO timestamp of last run, or null',
    nullable: true,
  })
  lastRunAt!: string | null;

  @ApiProperty({ description: 'Count of positions in RECONCILIATION_REQUIRED' })
  outstandingDiscrepancies!: number;
}

export class ReconciliationStatusResponseDto {
  @ApiProperty({ type: ReconciliationStatusDataDto })
  data!: ReconciliationStatusDataDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
