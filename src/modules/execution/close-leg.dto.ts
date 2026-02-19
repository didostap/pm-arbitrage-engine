import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CloseLegDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rationale?: string;
}
