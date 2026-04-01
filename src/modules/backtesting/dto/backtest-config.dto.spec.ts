import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

describe('BacktestConfigDto', () => {
  const validInput = {
    dateRangeStart: '2025-01-01T00:00:00Z',
    dateRangeEnd: '2025-03-01T00:00:00Z',
  };

  it('[P0] should accept valid config with all required fields', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, validInput);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P0] should apply correct default values', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, validInput);
    expect(dto.edgeThresholdPct).toBe(0.008);
    expect(dto.positionSizePct).toBe(0.03);
    expect(dto.maxConcurrentPairs).toBe(10);
    expect(dto.bankrollUsd).toBe('10000');
    expect(dto.tradingWindowStartHour).toBe(14);
    expect(dto.tradingWindowEndHour).toBe(23);
    expect(dto.gasEstimateUsd).toBe('0.50');
    expect(dto.exitEdgeEvaporationPct).toBe(0.002);
    expect(dto.exitTimeLimitHours).toBe(72);
    expect(dto.exitProfitCapturePct).toBe(0.8);
    expect(dto.minConfidenceScore).toBe(0.8);
    expect(dto.timeoutSeconds).toBe(300);
  });

  it('[P1] should reject missing dateRangeStart', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      dateRangeEnd: '2025-03-01T00:00:00Z',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'dateRangeStart')).toBe(true);
  });

  it('[P1] should reject missing dateRangeEnd', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      dateRangeStart: '2025-01-01T00:00:00Z',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'dateRangeEnd')).toBe(true);
  });

  it('[P1] should reject edgeThresholdPct outside 0-1 range', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dtoOver = plainToInstance(BacktestConfigDto, {
      ...validInput,
      edgeThresholdPct: 1.5,
    });
    const errorsOver = await validate(dtoOver);
    expect(errorsOver.some((e) => e.property === 'edgeThresholdPct')).toBe(
      true,
    );

    const dtoUnder = plainToInstance(BacktestConfigDto, {
      ...validInput,
      edgeThresholdPct: -0.1,
    });
    const errorsUnder = await validate(dtoUnder);
    expect(errorsUnder.some((e) => e.property === 'edgeThresholdPct')).toBe(
      true,
    );
  });

  it('[P1] should reject positionSizePct outside 0-1 range', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      positionSizePct: 2.0,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'positionSizePct')).toBe(true);
  });

  it('[P1] should reject maxConcurrentPairs < 1 or > 100', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dtoZero = plainToInstance(BacktestConfigDto, {
      ...validInput,
      maxConcurrentPairs: 0,
    });
    const errorsZero = await validate(dtoZero);
    expect(errorsZero.some((e) => e.property === 'maxConcurrentPairs')).toBe(
      true,
    );

    const dtoOver = plainToInstance(BacktestConfigDto, {
      ...validInput,
      maxConcurrentPairs: 101,
    });
    const errorsOver = await validate(dtoOver);
    expect(errorsOver.some((e) => e.property === 'maxConcurrentPairs')).toBe(
      true,
    );
  });

  it('[P1] should reject tradingWindowStartHour outside 0-23', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      tradingWindowStartHour: 24,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tradingWindowStartHour')).toBe(
      true,
    );
  });

  it('[P1] should reject timeoutSeconds < 60 or > 3600', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dtoLow = plainToInstance(BacktestConfigDto, {
      ...validInput,
      timeoutSeconds: 30,
    });
    const errorsLow = await validate(dtoLow);
    expect(errorsLow.some((e) => e.property === 'timeoutSeconds')).toBe(true);

    const dtoHigh = plainToInstance(BacktestConfigDto, {
      ...validInput,
      timeoutSeconds: 7200,
    });
    const errorsHigh = await validate(dtoHigh);
    expect(errorsHigh.some((e) => e.property === 'timeoutSeconds')).toBe(true);
  });

  it('[P1] should accept bankrollUsd and gasEstimateUsd as string values', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      bankrollUsd: '50000',
      gasEstimateUsd: '1.25',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(typeof dto.bankrollUsd).toBe('string');
    expect(typeof dto.gasEstimateUsd).toBe('string');
  });

  it('[P1] should default walkForwardEnabled=false and walkForwardTrainPct=0.70', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, validInput);
    expect(dto.walkForwardEnabled).toBe(false);
    expect(dto.walkForwardTrainPct).toBe(0.7);
  });

  it('[P1] should reject exitEdgeEvaporationPct outside 0-1 range', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      exitEdgeEvaporationPct: -0.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'exitEdgeEvaporationPct')).toBe(
      true,
    );
  });

  it('[P1] should reject exitTimeLimitHours < 1', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      exitTimeLimitHours: 0,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'exitTimeLimitHours')).toBe(true);
  });

  it('[P1] should reject exitProfitCapturePct outside 0-1 range', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      exitProfitCapturePct: 1.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'exitProfitCapturePct')).toBe(
      true,
    );
  });

  // 10-9-3a ATDD: UNIT-001
  it('[P0] chunkWindowDays defaults to 1 when not provided', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, validInput);
    expect(dto.chunkWindowDays).toBe(1);
  });

  // 10-9-3a ATDD: UNIT-002
  it('[P1] chunkWindowDays accepts valid integer values (1, 7, 15, 30)', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    for (const value of [1, 7, 15, 30]) {
      const dto = plainToInstance(BacktestConfigDto, {
        ...validInput,
        chunkWindowDays: value,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'chunkWindowDays')).toBe(false);
    }
  });

  // 10-9-3a ATDD: UNIT-003
  it('[P1] chunkWindowDays rejects value 0 (below @Min(1))', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      chunkWindowDays: 0,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'chunkWindowDays')).toBe(true);
  });

  // 10-9-3a ATDD: UNIT-004
  it('[P1] chunkWindowDays rejects value 31 (above @Max(30))', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      chunkWindowDays: 31,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'chunkWindowDays')).toBe(true);
  });

  // 10-9-3a ATDD: UNIT-005
  it('[P1] chunkWindowDays rejects non-integer values (e.g., 1.5)', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      chunkWindowDays: 1.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'chunkWindowDays')).toBe(true);
  });

  // 10-9-3a ATDD: UNIT-006
  it('[P2] chunkWindowDays rejects negative values', async () => {
    const { BacktestConfigDto } = await import('./backtest-config.dto');
    const dto = plainToInstance(BacktestConfigDto, {
      ...validInput,
      chunkWindowDays: -5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'chunkWindowDays')).toBe(true);
  });

  // 10-9-3a ATDD: UNIT-007
  it('[P0] IBacktestConfig interface includes chunkWindowDays: number', async () => {
    const config: import('../../../common/interfaces/backtest-engine.interface').IBacktestConfig =
      {
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-03-01T00:00:00Z',
        edgeThresholdPct: 0.008,
        minConfidenceScore: 0.8,
        positionSizePct: 0.03,
        maxConcurrentPairs: 10,
        bankrollUsd: '10000',
        tradingWindowStartHour: 14,
        tradingWindowEndHour: 23,
        gasEstimateUsd: '0.50',
        exitEdgeEvaporationPct: 0.002,
        exitTimeLimitHours: 72,
        exitProfitCapturePct: 0.8,
        walkForwardEnabled: false,
        walkForwardTrainPct: 0.7,
        timeoutSeconds: 300,
        chunkWindowDays: 1,
      };
    expect(config.chunkWindowDays).toBe(1);
  });
});
