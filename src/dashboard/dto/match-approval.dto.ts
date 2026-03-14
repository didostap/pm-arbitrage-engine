import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsEnum,
  IsInt,
  IsUUID,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SortOrder } from './common-query.dto';

// ─── Request DTOs ────────────────────────────────────────────────────────────

export class ApproveMatchDto {
  @ApiProperty({
    description: 'Operator rationale for approval',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  rationale!: string;
}

export class RejectMatchDto {
  @ApiProperty({
    description: 'Operator rationale for rejection',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  rationale!: string;
}

export enum MatchStatusFilter {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ALL = 'all',
}

export enum ResolutionStatusFilter {
  RESOLVED = 'resolved',
  UNRESOLVED = 'unresolved',
  DIVERGED = 'diverged',
}

export enum MatchSortField {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  CONFIDENCE_SCORE = 'confidenceScore',
  RESOLUTION_DATE = 'resolutionDate',
  TOTAL_CYCLES_TRADED = 'totalCyclesTraded',
  OPERATOR_APPROVED = 'operatorApproved',
  FIRST_TRADED_TIMESTAMP = 'firstTradedTimestamp',
  LAST_ANNUALIZED_RETURN = 'lastAnnualizedReturn',
  LAST_NET_EDGE = 'lastNetEdge',
  LAST_COMPUTED_AT = 'lastComputedAt',
}

export class MatchListQueryDto {
  @ApiPropertyOptional({
    enum: MatchStatusFilter,
    default: MatchStatusFilter.ALL,
    description: 'Filter by match status',
  })
  @IsOptional()
  @IsEnum(MatchStatusFilter)
  status?: MatchStatusFilter;

  @ApiPropertyOptional({ default: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, description: 'Items per page (max 100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: ResolutionStatusFilter,
    description: 'Filter by resolution status',
  })
  @IsOptional()
  @IsEnum(ResolutionStatusFilter)
  resolution?: ResolutionStatusFilter;

  @ApiPropertyOptional({ description: 'Filter by correlation cluster ID' })
  @IsOptional()
  @IsUUID()
  clusterId?: string;

  @ApiPropertyOptional({
    enum: MatchSortField,
    description: 'Field to sort by',
  })
  @IsOptional()
  @IsEnum(MatchSortField)
  sortBy?: MatchSortField;

  @ApiPropertyOptional({
    enum: SortOrder,
    description: 'Sort direction (default: desc when sortBy is provided)',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder;
}

// ─── Response DTOs ───────────────────────────────────────────────────────────

export class ClusterSummaryDto {
  @ApiProperty({ description: 'Cluster ID' }) id!: string;
  @ApiProperty({ description: 'Cluster name' }) name!: string;
  @ApiProperty({ description: 'Cluster slug' }) slug!: string;
}

export class MatchSummaryDto {
  @ApiProperty() matchId!: string;
  @ApiProperty() polymarketContractId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Polymarket CLOB token ID for trading (null for auto-discovered pairs without CLOB mapping)',
  })
  polymarketClobTokenId!: string | null;
  @ApiProperty() kalshiContractId!: string;
  @ApiProperty() polymarketDescription!: string;
  @ApiProperty() kalshiDescription!: string;
  @ApiProperty() operatorApproved!: boolean;
  @ApiProperty({ nullable: true, type: String })
  operatorApprovalTimestamp!: string | null;
  @ApiProperty({ nullable: true, type: String })
  operatorRationale!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Confidence score (0-100, null if not yet calculated)',
  })
  confidenceScore!: number | null;
  @ApiProperty({ nullable: true, type: String })
  polymarketResolution!: string | null;
  @ApiProperty({ nullable: true, type: String })
  kalshiResolution!: string | null;
  @ApiProperty({ nullable: true, type: String })
  resolutionTimestamp!: string | null;
  @ApiProperty({ nullable: true, type: Boolean })
  resolutionDiverged!: boolean | null;
  @ApiProperty({ nullable: true, type: String })
  divergenceNotes!: string | null;
  @ApiProperty({ nullable: true, type: String })
  polymarketRawCategory!: string | null;
  @ApiProperty({ nullable: true, type: String })
  kalshiRawCategory!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'First traded timestamp (ISO 8601)',
  })
  firstTradedTimestamp!: string | null;
  @ApiProperty({ description: 'Total number of trading cycles' })
  totalCyclesTraded!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Primary leg platform',
  })
  primaryLeg!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Resolution date (ISO 8601)',
  })
  resolutionDate!: string | null;
  @ApiProperty({ nullable: true, type: String })
  resolutionCriteriaHash!: string | null;
  @ApiProperty({
    nullable: true,
    type: () => ClusterSummaryDto,
    description: 'Correlation cluster',
  })
  cluster!: ClusterSummaryDto | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Last computed annualized return (decimal, e.g. 0.42 = 42%)',
  })
  lastAnnualizedReturn!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Last computed net edge (decimal)',
  })
  lastNetEdge!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Timestamp of last APR computation (ISO 8601)',
  })
  lastComputedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class MatchListResponseDto {
  @ApiProperty({ type: [MatchSummaryDto] })
  data!: MatchSummaryDto[];

  @ApiProperty({ description: 'Total count of matching records' })
  count!: number;

  @ApiProperty({ description: 'Current page number' })
  page!: number;

  @ApiProperty({ description: 'Items per page' })
  limit!: number;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class MatchDetailResponseDto {
  @ApiProperty({ type: MatchSummaryDto })
  data!: MatchSummaryDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class ClusterListResponseDto {
  @ApiProperty({ type: [ClusterSummaryDto] })
  data!: ClusterSummaryDto[];

  @ApiProperty({ description: 'Total count' })
  count!: number;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}

export class MatchActionDataDto {
  @ApiProperty() matchId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() operatorRationale!: string;
  @ApiProperty({ description: 'Action timestamp (ISO 8601)' })
  timestamp!: string;
}

export class MatchActionResponseDto {
  @ApiProperty({ type: MatchActionDataDto })
  data!: MatchActionDataDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
