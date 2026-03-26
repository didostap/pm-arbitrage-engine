import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// RED: DTO class does not exist yet
// import { HistoricalDataQueryDto } from './historical-data-query.dto';

describe('HistoricalDataQueryDto', () => {
  it('[P1] should accept valid input with required fields only', async () => {
    const { HistoricalDataQueryDto } =
      await import('./historical-data-query.dto');
    const dto = plainToInstance(HistoricalDataQueryDto, {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] should accept valid input with optional filters', async () => {
    const { HistoricalDataQueryDto } =
      await import('./historical-data-query.dto');
    const dto = plainToInstance(HistoricalDataQueryDto, {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
      contractIds: ['KXBTC-24DEC31', '0x1234'],
      sources: ['KALSHI_API', 'GOLDSKY'],
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] should reject missing required fields', async () => {
    const { HistoricalDataQueryDto } =
      await import('./historical-data-query.dto');
    const dto = plainToInstance(HistoricalDataQueryDto, {});

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
