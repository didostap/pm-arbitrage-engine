import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min, Max, IsIn, IsOptional } from 'class-validator';

export class TaxReportQueryDto {
  @ApiProperty({
    description: 'Tax year',
    example: 2026,
    minimum: 2024,
    maximum: 2100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({ enum: ['csv'], default: 'csv' })
  @IsIn(['csv'])
  @IsOptional()
  format = 'csv' as const;
}
