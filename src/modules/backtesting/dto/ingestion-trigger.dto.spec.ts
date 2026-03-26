import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// RED: DTO class does not exist yet
// import { IngestionTriggerDto } from './ingestion-trigger.dto';

describe('IngestionTriggerDto', () => {
  it('[P1] should accept valid input with required fields only', async () => {
    const { IngestionTriggerDto } = await import('./ingestion-trigger.dto');
    const dto = plainToInstance(IngestionTriggerDto, {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] should reject missing dateRangeStart', async () => {
    const { IngestionTriggerDto } = await import('./ingestion-trigger.dto');
    const dto = plainToInstance(IngestionTriggerDto, {
      dateRangeEnd: '2025-03-01T00:00:00Z',
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'dateRangeStart')).toBe(true);
  });

  it('[P1] should reject missing dateRangeEnd', async () => {
    const { IngestionTriggerDto } = await import('./ingestion-trigger.dto');
    const dto = plainToInstance(IngestionTriggerDto, {
      dateRangeStart: '2025-01-01T00:00:00Z',
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'dateRangeEnd')).toBe(true);
  });

  it('[P1] should reject invalid date strings', async () => {
    const { IngestionTriggerDto } = await import('./ingestion-trigger.dto');
    const dto = plainToInstance(IngestionTriggerDto, {
      dateRangeStart: 'not-a-date',
      dateRangeEnd: 'also-not-a-date',
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
