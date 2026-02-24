import { IsISO8601, IsIn, IsOptional } from 'class-validator';

export class TradeExportQueryDto {
  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;

  @IsIn(['json', 'csv'])
  @IsOptional()
  format: 'json' | 'csv' = 'json';
}
