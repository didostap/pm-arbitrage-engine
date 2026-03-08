import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ClosePositionDto {
  @ApiPropertyOptional({ description: 'Operator rationale for closing' })
  @IsOptional()
  @IsString()
  rationale?: string;
}
