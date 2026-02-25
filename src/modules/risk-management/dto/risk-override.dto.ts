import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class RiskOverrideDto {
  @ApiProperty({ description: 'Opportunity ID to override' })
  @IsString()
  @IsNotEmpty()
  opportunityId!: string;

  @ApiProperty({
    description: 'Operator rationale for override',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  rationale!: string;
}
