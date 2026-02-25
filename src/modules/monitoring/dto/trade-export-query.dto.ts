import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsIn, IsOptional } from 'class-validator';

export class TradeExportQueryDto {
  @ApiProperty({ description: 'Start date (ISO 8601)', example: '2026-01-01' })
  @IsISO8601()
  startDate!: string;

  @ApiProperty({ description: 'End date (ISO 8601)', example: '2026-01-31' })
  @IsISO8601()
  endDate!: string;

  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' })
  @IsIn(['json', 'csv'])
  @IsOptional()
  format: 'json' | 'csv' = 'json';
}
