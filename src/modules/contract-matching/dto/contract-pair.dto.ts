import {
  IsString,
  IsNotEmpty,
  MinLength,
  IsOptional,
  IsEnum,
  IsISO8601,
  ValidateNested,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum PrimaryLeg {
  KALSHI = 'kalshi',
  POLYMARKET = 'polymarket',
}

export class ContractPairDto {
  @IsString()
  @IsNotEmpty()
  polymarketContractId!: string;

  @IsString()
  @IsNotEmpty()
  kalshiContractId!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  eventDescription!: string;

  @IsISO8601()
  operatorVerificationTimestamp!: string;

  @IsOptional()
  @IsEnum(PrimaryLeg)
  primaryLeg?: PrimaryLeg = PrimaryLeg.KALSHI;
}

// Sprint 0 scope: schema + validation logic only. Startup wiring (loading contract-pairs.yaml,
// calling validate(), and failing on errors) belongs to Story 3.1 (manual-contract-pair-configuration).
export class ContractPairsConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractPairDto)
  pairs!: ContractPairDto[];

  /**
   * Validate duplicate contract IDs and soft warn on >30 pairs.
   * These are custom validations run after class-validator decorators.
   */
  static validateDuplicatesAndLimits(pairs: ContractPairDto[]): string[] {
    const errors: string[] = [];

    const polyIds = new Set<string>();
    const kalshiIds = new Set<string>();

    for (const pair of pairs) {
      if (polyIds.has(pair.polymarketContractId)) {
        errors.push(
          `Duplicate polymarketContractId: ${pair.polymarketContractId}`,
        );
      }
      polyIds.add(pair.polymarketContractId);

      if (kalshiIds.has(pair.kalshiContractId)) {
        errors.push(`Duplicate kalshiContractId: ${pair.kalshiContractId}`);
      }
      kalshiIds.add(pair.kalshiContractId);
    }

    if (pairs.length > 30) {
      errors.push(
        `Warning: ${pairs.length} pairs configured (exceeds recommended max of 30)`,
      );
    }

    return errors;
  }
}
