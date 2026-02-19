import { IsNumber, IsPositive, Max } from 'class-validator';

export class RetryLegDto {
  @IsNumber()
  @IsPositive()
  @Max(1)
  price!: number;
}
