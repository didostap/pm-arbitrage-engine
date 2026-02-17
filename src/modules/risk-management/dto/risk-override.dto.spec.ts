import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RiskOverrideDto } from './risk-override.dto';

function toDto(data: Record<string, unknown>): RiskOverrideDto {
  return plainToInstance(RiskOverrideDto, data);
}

describe('RiskOverrideDto', () => {
  it('should accept valid input', async () => {
    const dto = toDto({
      opportunityId: 'opp-123',
      rationale: 'High conviction based on market analysis',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty opportunityId', async () => {
    const dto = toDto({
      opportunityId: '',
      rationale: 'High conviction based on market analysis',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'opportunityId')).toBe(true);
  });

  it('should reject missing opportunityId', async () => {
    const dto = toDto({
      rationale: 'High conviction based on market analysis',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'opportunityId')).toBe(true);
  });

  it('should reject rationale shorter than 10 characters', async () => {
    const dto = toDto({
      opportunityId: 'opp-123',
      rationale: 'short',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'rationale')).toBe(true);
  });

  it('should reject missing rationale', async () => {
    const dto = toDto({
      opportunityId: 'opp-123',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'rationale')).toBe(true);
  });

  it('should accept rationale of exactly 10 characters', async () => {
    const dto = toDto({
      opportunityId: 'opp-123',
      rationale: '1234567890',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
