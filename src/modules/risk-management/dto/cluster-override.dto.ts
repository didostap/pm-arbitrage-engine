import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ClusterOverrideDto {
  @ApiProperty({ description: 'ID of the contract match to reassign' })
  @IsString()
  @IsNotEmpty()
  matchId!: string;

  @ApiProperty({ description: 'ID of the target correlation cluster' })
  @IsString()
  @IsNotEmpty()
  newClusterId!: string;

  @ApiProperty({
    description: 'Operator rationale for the override',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  rationale!: string;
}
