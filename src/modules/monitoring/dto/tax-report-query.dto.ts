import { Type } from 'class-transformer';
import { IsInt, Min, Max, IsIn, IsOptional } from 'class-validator';

export class TaxReportQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year!: number;

  @IsIn(['csv'])
  @IsOptional()
  format = 'csv' as const;
}
