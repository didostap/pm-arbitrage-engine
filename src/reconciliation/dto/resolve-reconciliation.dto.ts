import { IsIn, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResolveReconciliationDto {
  @IsIn(['acknowledge', 'force_close'])
  action!: 'acknowledge' | 'force_close';

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  rationale!: string;
}
