import { IsDateString, IsOptional, IsArray, IsString } from 'class-validator';

export class HistoricalDataQueryDto {
  @IsDateString()
  dateRangeStart!: string;

  @IsDateString()
  dateRangeEnd!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contractIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sources?: string[];
}
