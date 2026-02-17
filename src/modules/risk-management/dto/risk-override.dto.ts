import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class RiskOverrideDto {
  @IsString()
  @IsNotEmpty()
  opportunityId!: string;

  @IsString()
  @MinLength(10)
  rationale!: string;
}
