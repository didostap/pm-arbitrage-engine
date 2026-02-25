import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResolveReconciliationDto {
  @ApiProperty({
    enum: ['acknowledge', 'force_close'],
    description: 'Resolution action',
  })
  @IsIn(['acknowledge', 'force_close'])
  action!: 'acknowledge' | 'force_close';

  @ApiProperty({
    description: 'Operator rationale for resolution',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  rationale!: string;
}
