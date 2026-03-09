import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CloseAllPositionsDto {
  @ApiPropertyOptional({
    description: 'Operator rationale for batch close',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rationale?: string;
}
