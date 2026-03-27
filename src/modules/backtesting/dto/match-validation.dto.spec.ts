import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  TriggerValidationDto,
  getEffectiveSources,
  ValidationReportResponseDto,
} from './match-validation.dto';

describe('TriggerValidationDto', () => {
  it('[P1] should accept valid TriggerValidationDto with includeSources array', async () => {
    const dto = plainToInstance(TriggerValidationDto, {
      includeSources: ['oddspipe', 'predexon'],
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] should default to both sources when includeSources omitted or empty', () => {
    expect(getEffectiveSources(undefined)).toEqual(['oddspipe', 'predexon']);
    expect(getEffectiveSources([])).toEqual(['oddspipe', 'predexon']);
  });

  it('[P1] should return specified sources when provided', () => {
    expect(getEffectiveSources(['oddspipe'])).toEqual(['oddspipe']);
    expect(getEffectiveSources(['predexon'])).toEqual(['predexon']);
    expect(getEffectiveSources(['oddspipe', 'predexon'])).toEqual([
      'oddspipe',
      'predexon',
    ]);
  });

  it('[P1] should reject unknown source names with validation error', async () => {
    const dto = plainToInstance(TriggerValidationDto, {
      includeSources: ['oddspipe', 'unknown_source'],
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'includeSources')).toBe(true);
  });
});

describe('ValidationReportResponseDto', () => {
  it('[P3] should be constructable with required fields', () => {
    const dto = new ValidationReportResponseDto();
    dto.reportId = 1;
    dto.summary = {
      confirmedCount: 5,
      ourOnlyCount: 3,
      externalOnlyCount: 2,
      conflictCount: 1,
      totalOurMatches: 10,
      totalOddsPipePairs: 100,
      totalPredexonPairs: 200,
      sourcesQueried: ['oddspipe', 'predexon'],
    };
    dto.entries = [];

    expect(dto.reportId).toBe(1);
    expect(dto.summary.confirmedCount).toBe(5);
    expect(dto.entries).toEqual([]);
  });
});
