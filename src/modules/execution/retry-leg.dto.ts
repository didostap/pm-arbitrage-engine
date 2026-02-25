import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, Max } from 'class-validator';

export class RetryLegDto {
  @ApiProperty({
    description: 'Retry price (decimal probability 0-1)',
    example: 0.55,
    maximum: 1,
  })
  @IsNumber()
  @IsPositive()
  @Max(1)
  price!: number;
}
