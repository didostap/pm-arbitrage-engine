import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isPositiveDecimal', async: false })
class IsPositiveDecimalConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    const num = parseFloat(value);
    return !isNaN(num) && num > 0;
  }

  defaultMessage(): string {
    return 'Must be a positive number greater than zero';
  }
}

export class BankrollConfigDto {
  @ApiProperty({
    description: 'Bankroll value as decimal string',
    example: '10000',
  })
  bankrollUsd!: string;

  @ApiProperty({
    description: 'Last updated timestamp (ISO 8601)',
    example: '2026-03-14T10:00:00.000Z',
  })
  updatedAt!: string;
}

export class UpdateBankrollDto {
  @ApiProperty({
    description: 'New bankroll value as decimal string',
    example: '15000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'Must be a valid positive decimal string',
  })
  @Validate(IsPositiveDecimalConstraint)
  bankrollUsd!: string;
}

export class BankrollConfigResponseDto {
  @ApiProperty({ type: BankrollConfigDto })
  data!: BankrollConfigDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
