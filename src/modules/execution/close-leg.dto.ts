import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CloseLegDto {
  @ApiPropertyOptional({
    description: 'Operator rationale for closing',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rationale?: string;
}
