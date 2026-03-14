import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsString,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export enum PositionSortField {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  EXPECTED_EDGE = 'expectedEdge',
  STATUS = 'status',
  IS_PAPER = 'isPaper',
}

export class PositionsQueryDto {
  @ApiPropertyOptional({
    enum: ['live', 'paper', 'all'],
    description: 'Filter by trading mode (default: all)',
  })
  @IsOptional()
  @IsEnum(['live', 'paper', 'all'])
  mode?: 'live' | 'paper' | 'all';

  @ApiPropertyOptional({ default: 1, description: 'Page number (default: 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: 50,
    description: 'Items per page (default: 50, max: 200)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    type: String,
    description:
      'Comma-separated status filter (e.g. "OPEN,EXIT_PARTIAL"). Omit for default open statuses. Empty string for all statuses.',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    enum: PositionSortField,
    description: 'Field to sort by (default: updatedAt)',
  })
  @IsOptional()
  @IsEnum(PositionSortField)
  sortBy?: PositionSortField;

  @ApiPropertyOptional({
    enum: SortOrder,
    description: 'Sort direction (default: desc)',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder;

  @ApiPropertyOptional({
    description: 'Filter positions by contract match ID (UUID)',
  })
  @IsOptional()
  @IsUUID()
  matchId?: string;
}
