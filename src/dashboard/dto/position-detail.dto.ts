import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderDetailDto {
  @ApiProperty({ description: 'Order ID' })
  orderId!: string;

  @ApiProperty({ description: 'Platform', enum: ['KALSHI', 'POLYMARKET'] })
  platform!: string;

  @ApiProperty({ description: 'Order side', enum: ['buy', 'sell'] })
  side!: string;

  @ApiProperty({
    description: 'Requested price (decimal string)',
    type: String,
  })
  requestedPrice!: string;

  @ApiPropertyOptional({
    description: 'Fill price (decimal string, null if not filled)',
    type: String,
    nullable: true,
  })
  fillPrice!: string | null;

  @ApiPropertyOptional({
    description: 'Fill size (decimal string, null if not filled)',
    type: String,
    nullable: true,
  })
  fillSize!: string | null;

  @ApiPropertyOptional({
    description: 'Slippage: fill price - requested price (decimal string)',
    type: String,
    nullable: true,
  })
  slippage!: string | null;

  @ApiProperty({
    description: 'Order status',
    enum: ['PENDING', 'FILLED', 'PARTIAL', 'REJECTED', 'CANCELLED'],
  })
  status!: string;

  @ApiProperty({ description: 'Created timestamp (ISO 8601)' })
  createdAt!: string;

  @ApiProperty({ description: 'Last updated timestamp (ISO 8601)' })
  updatedAt!: string;
}

export class AuditEventDto {
  @ApiProperty({ description: 'Audit event ID' })
  id!: string;

  @ApiProperty({ description: 'Event type (dot notation)' })
  eventType!: string;

  @ApiProperty({ description: 'Event timestamp (ISO 8601)' })
  timestamp!: string;

  @ApiProperty({
    description: 'Human-readable summary extracted from event details',
  })
  summary!: string;

  @ApiPropertyOptional({
    description: 'Raw event details (JSON object)',
    nullable: true,
    type: 'object',
    additionalProperties: {},
  })
  details?: Record<string, unknown> | null;
}

export class CapitalBreakdownDto {
  @ApiPropertyOptional({
    description: 'Entry capital for Kalshi leg (decimal string)',
    type: String,
    nullable: true,
  })
  entryCapitalKalshi!: string | null;

  @ApiPropertyOptional({
    description: 'Entry capital for Polymarket leg (decimal string)',
    type: String,
    nullable: true,
  })
  entryCapitalPolymarket!: string | null;

  @ApiPropertyOptional({
    description: 'Total Kalshi fees (decimal string)',
    type: String,
    nullable: true,
  })
  feesKalshi!: string | null;

  @ApiPropertyOptional({
    description: 'Total Polymarket fees (decimal string)',
    type: String,
    nullable: true,
  })
  feesPolymarket!: string | null;

  @ApiPropertyOptional({
    description: 'Gross P&L before fees (decimal string)',
    type: String,
    nullable: true,
  })
  grossPnl!: string | null;

  @ApiPropertyOptional({
    description: 'Net P&L after fees (decimal string)',
    type: String,
    nullable: true,
  })
  netPnl!: string | null;
}

export class PositionFullDetailDto {
  @ApiProperty({ description: 'Position ID' })
  id!: string;

  @ApiProperty({ description: 'Contract match pair ID' })
  pairId!: string;

  @ApiProperty({ description: 'Contract pair name' })
  pairName!: string;

  @ApiProperty({ description: 'Position status' })
  status!: string;

  @ApiProperty({ description: 'Whether this is a paper trading position' })
  isPaper!: boolean;

  @ApiProperty({ description: 'Created timestamp (ISO 8601)' })
  createdAt!: string;

  @ApiProperty({ description: 'Last updated timestamp (ISO 8601)' })
  updatedAt!: string;

  @ApiPropertyOptional({
    description: 'Initial edge at entry (decimal string)',
    type: String,
  })
  initialEdge!: string;

  @ApiPropertyOptional({
    description: 'Entry prices per platform',
    nullable: true,
  })
  entryPrices!: { kalshi: string; polymarket: string } | null;

  @ApiPropertyOptional({
    description: 'Current prices per platform (null if unavailable)',
    nullable: true,
  })
  currentPrices!: {
    kalshi: string | null;
    polymarket: string | null;
    kalshiDepthSufficient?: boolean;
    polymarketDepthSufficient?: boolean;
  } | null;

  @ApiPropertyOptional({
    description: 'Current edge (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  currentEdge!: string | null;

  @ApiPropertyOptional({
    description: 'Unrealized P&L (decimal string, null if unavailable)',
    type: String,
    nullable: true,
  })
  unrealizedPnl!: string | null;

  @ApiPropertyOptional({
    description:
      'Realized P&L in USD for closed positions (decimal string, null for open)',
    type: String,
    nullable: true,
  })
  realizedPnl!: string | null;

  @ApiPropertyOptional({
    description: 'Time held since entry (human-readable)',
    type: String,
    nullable: true,
  })
  timeHeld!: string | null;

  @ApiPropertyOptional({
    description: 'Entry reasoning from risk budget reservation event',
    type: String,
    nullable: true,
  })
  entryReasoning!: string | null;

  @ApiPropertyOptional({
    description: 'Exit type for closed/partially exited positions',
    enum: ['stop_loss', 'take_profit', 'time_based', 'manual'],
    nullable: true,
  })
  exitType!: string | null;

  @ApiProperty({
    description: 'All orders for this position (entry + exit + retries)',
    type: [OrderDetailDto],
  })
  orders!: OrderDetailDto[];

  @ApiProperty({
    description: 'Audit trail events for this position',
    type: [AuditEventDto],
  })
  auditEvents!: AuditEventDto[];

  @ApiProperty({
    description: 'Capital breakdown',
    type: CapitalBreakdownDto,
  })
  capitalBreakdown!: CapitalBreakdownDto;

  @ApiPropertyOptional({
    description:
      'Recalculated current market edge (decimal string, null if not yet computed)',
    type: String,
    nullable: true,
  })
  recalculatedEdge!: string | null;

  @ApiPropertyOptional({
    description:
      'Edge delta since entry: recalculatedEdge - expectedEdge (decimal string)',
    type: String,
    nullable: true,
  })
  edgeDelta!: string | null;

  @ApiPropertyOptional({
    description: 'Last recalculation timestamp (ISO 8601)',
    type: String,
    nullable: true,
  })
  lastRecalculatedAt!: string | null;

  @ApiPropertyOptional({
    description: 'Data source: websocket, polling, or stale_fallback',
    type: String,
    nullable: true,
  })
  dataSource!: string | null;

  @ApiPropertyOptional({
    description: 'Data freshness in milliseconds (null if unknown)',
    type: Number,
    nullable: true,
  })
  dataFreshnessMs!: number | null;

  // ─── Six-Criteria Model Fields (Story 10.2) ──────────────────────────────

  @ApiPropertyOptional({
    description: 'Exit mode: fixed, model, or shadow',
    type: String,
    nullable: true,
  })
  exitMode?: string | null;

  @ApiPropertyOptional({
    description: 'All 6 criterion evaluation results (model/shadow mode only)',
    type: 'array',
    nullable: true,
  })
  exitCriteria?: Array<{
    criterion: string;
    proximity: string;
    triggered: boolean;
    detail?: string;
  }> | null;

  @ApiPropertyOptional({
    description: 'Highest proximity criterion name (model/shadow mode only)',
    type: String,
    nullable: true,
  })
  closestCriterion?: string | null;

  @ApiPropertyOptional({
    description: 'Highest proximity value 0-1 (model/shadow mode only)',
    type: Number,
    nullable: true,
  })
  closestProximity?: number | null;
}
