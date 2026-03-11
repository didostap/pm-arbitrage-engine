import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

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
}

// ─── Response DTOs ───────────────────────────────────────────────────────────

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
