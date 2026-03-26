import { IsDateString } from 'class-validator';

export class IngestionTriggerDto {
  @IsDateString()
  dateRangeStart!: string;

  @IsDateString()
  dateRangeEnd!: string;
}
