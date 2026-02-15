import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ContractPairDto,
  ContractPairsConfigDto,
  PrimaryLeg,
} from './contract-pair.dto';

function makeValidPair(
  overrides: Partial<ContractPairDto> = {},
): Record<string, unknown> {
  return {
    polymarketContractId: 'poly-abc-123',
    kalshiContractId: 'kalshi-xyz-456',
    eventDescription: 'Will X happen by Y date?',
    operatorVerificationTimestamp: '2026-02-15T12:00:00Z',
    primaryLeg: PrimaryLeg.KALSHI,
    ...overrides,
  };
}

describe('ContractPairDto', () => {
  it('should pass validation with all valid fields', async () => {
    const dto = plainToInstance(ContractPairDto, makeValidPair());
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should default primaryLeg to kalshi when omitted', () => {
    const data = makeValidPair();
    delete data.primaryLeg;
    const dto = plainToInstance(ContractPairDto, data);
    expect(dto.primaryLeg).toBe(PrimaryLeg.KALSHI);
  });

  it('should fail when polymarketContractId is missing', async () => {
    const data = makeValidPair();
    delete data.polymarketContractId;
    const dto = plainToInstance(ContractPairDto, data);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('polymarketContractId');
  });

  it('should fail when kalshiContractId is empty string', async () => {
    const dto = plainToInstance(
      ContractPairDto,
      makeValidPair({ kalshiContractId: '' }),
    );
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('kalshiContractId');
  });

  it('should fail when operatorVerificationTimestamp is not ISO 8601', async () => {
    const dto = plainToInstance(
      ContractPairDto,
      makeValidPair({
        operatorVerificationTimestamp: 'not-a-date',
      }),
    );
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('operatorVerificationTimestamp');
  });

  it('should fail when primaryLeg is invalid enum value', async () => {
    const dto = plainToInstance(
      ContractPairDto,
      makeValidPair({ primaryLeg: 'binance' as PrimaryLeg }),
    );
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('primaryLeg');
  });
});

describe('ContractPairsConfigDto.validateDuplicatesAndLimits', () => {
  it('should return no errors for unique pairs', () => {
    const pairs = [
      plainToInstance(ContractPairDto, makeValidPair()),
      plainToInstance(
        ContractPairDto,
        makeValidPair({
          polymarketContractId: 'poly-def-789',
          kalshiContractId: 'kalshi-ghi-012',
        }),
      ),
    ];
    const errors = ContractPairsConfigDto.validateDuplicatesAndLimits(pairs);
    expect(errors).toHaveLength(0);
  });

  it('should detect duplicate polymarketContractId', () => {
    const pairs = [
      plainToInstance(ContractPairDto, makeValidPair()),
      plainToInstance(
        ContractPairDto,
        makeValidPair({ kalshiContractId: 'kalshi-different' }),
      ),
    ];
    const errors = ContractPairsConfigDto.validateDuplicatesAndLimits(pairs);
    expect(errors).toContainEqual(
      expect.stringContaining('Duplicate polymarketContractId'),
    );
  });

  it('should detect duplicate kalshiContractId', () => {
    const pairs = [
      plainToInstance(ContractPairDto, makeValidPair()),
      plainToInstance(
        ContractPairDto,
        makeValidPair({ polymarketContractId: 'poly-different' }),
      ),
    ];
    const errors = ContractPairsConfigDto.validateDuplicatesAndLimits(pairs);
    expect(errors).toContainEqual(
      expect.stringContaining('Duplicate kalshiContractId'),
    );
  });

  it('should warn when more than 30 pairs configured', () => {
    const pairs = Array.from({ length: 31 }, (_, i) =>
      plainToInstance(
        ContractPairDto,
        makeValidPair({
          polymarketContractId: `poly-${i}`,
          kalshiContractId: `kalshi-${i}`,
        }),
      ),
    );
    const errors = ContractPairsConfigDto.validateDuplicatesAndLimits(pairs);
    expect(errors).toContainEqual(
      expect.stringContaining('exceeds recommended max of 30'),
    );
  });
});
