import { describe, it, expect } from 'vitest';
import {
  entryPricesSchema,
  sizesSchema,
  calibrationTiersSchema,
  boundaryAnalysisSchema,
  recommendationsSchema,
  haltReasonSchema,
  reconciliationContextSchema,
  orderBookLevelsSchema,
  auditLogDetailsSchema,
} from './prisma-json.schema';

describe('entryPricesSchema', () => {
  it('should accept valid entry prices', () => {
    const result = entryPricesSchema.parse({
      kalshi: '0.65',
      polymarket: '0.35',
    });
    expect(result.kalshi).toBe('0.65');
  });

  it('should reject missing field', () => {
    expect(() => entryPricesSchema.parse({ kalshi: '0.5' })).toThrow();
  });

  it('should reject non-string values', () => {
    expect(() =>
      entryPricesSchema.parse({ kalshi: 0.5, polymarket: '0.5' }),
    ).toThrow();
  });
});

describe('sizesSchema', () => {
  it('should accept valid sizes', () => {
    const result = sizesSchema.parse({
      kalshi: '100',
      polymarket: '100',
    });
    expect(result.polymarket).toBe('100');
  });

  it('should reject missing field', () => {
    expect(() => sizesSchema.parse({ kalshi: '100' })).toThrow();
  });
});

describe('calibrationTiersSchema', () => {
  const validTiers = {
    autoApprove: {
      range: '>= 85',
      matchCount: 42,
      divergedCount: 2,
      divergenceRate: 4.8,
    },
    pendingReview: {
      range: '40 - 84',
      matchCount: 15,
      divergedCount: 3,
      divergenceRate: 20.0,
    },
    autoReject: {
      range: '< 40',
      matchCount: 3,
      divergedCount: 1,
      divergenceRate: 33.3,
    },
  };

  it('should accept valid calibration tiers', () => {
    const result = calibrationTiersSchema.parse(validTiers);
    expect(result.autoApprove.matchCount).toBe(42);
  });

  it('should reject missing tier', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { autoReject: _unused, ...partial } = validTiers;
    expect(() => calibrationTiersSchema.parse(partial)).toThrow();
  });

  it('should reject wrong type in band', () => {
    expect(() =>
      calibrationTiersSchema.parse({
        ...validTiers,
        autoApprove: { ...validTiers.autoApprove, matchCount: 'bad' },
      }),
    ).toThrow();
  });
});

describe('boundaryAnalysisSchema', () => {
  it('should accept valid boundary analysis array', () => {
    const result = boundaryAnalysisSchema.parse([
      {
        threshold: 80,
        matchesAbove: 52,
        divergedAbove: 4,
        divergenceRateAbove: 7.7,
        recommendation: null,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.recommendation).toBeNull();
  });

  it('should accept recommendation as string', () => {
    const result = boundaryAnalysisSchema.parse([
      {
        threshold: 80,
        matchesAbove: 52,
        divergedAbove: 4,
        divergenceRateAbove: 7.7,
        recommendation: 'Lower threshold',
      },
    ]);
    expect(result[0]?.recommendation).toBe('Lower threshold');
  });

  it('should reject missing required field', () => {
    expect(() => boundaryAnalysisSchema.parse([{ threshold: 80 }])).toThrow();
  });
});

describe('recommendationsSchema', () => {
  it('should accept string array', () => {
    const result = recommendationsSchema.parse(['rec1', 'rec2']);
    expect(result).toHaveLength(2);
  });

  it('should reject non-string elements', () => {
    expect(() => recommendationsSchema.parse([1, 2])).toThrow();
  });
});

describe('haltReasonSchema', () => {
  it('should accept known halt reasons', () => {
    const result = haltReasonSchema.parse([
      'daily_loss_limit',
      'reconciliation_discrepancy',
    ]);
    expect(result).toEqual(['daily_loss_limit', 'reconciliation_discrepancy']);
  });

  it('should accept empty array', () => {
    expect(haltReasonSchema.parse([])).toEqual([]);
  });

  it('should reject unknown halt reason values', () => {
    expect(() => haltReasonSchema.parse(['unknown_reason'])).toThrow();
  });

  it('should reject non-array', () => {
    expect(() =>
      haltReasonSchema.parse({ reason: 'test', timestamp: 'now' }),
    ).toThrow();
  });
});

describe('reconciliationContextSchema', () => {
  it('should accept object with any keys', () => {
    const result = reconciliationContextSchema.parse({
      recommendedStatus: 'SINGLE_LEG_EXPOSED',
      detectedAt: '2026-03-12T14:30:45.123Z',
    });
    expect(result).toHaveProperty('recommendedStatus');
  });

  it('should accept null', () => {
    expect(reconciliationContextSchema.parse(null)).toBeNull();
  });
});

describe('orderBookLevelsSchema', () => {
  it('should accept valid price levels', () => {
    const result = orderBookLevelsSchema.parse([
      { price: 0.65, quantity: 100 },
      { price: 0.64, quantity: 250 },
    ]);
    expect(result).toHaveLength(2);
  });

  it('should reject missing quantity', () => {
    expect(() => orderBookLevelsSchema.parse([{ price: 0.65 }])).toThrow();
  });
});

describe('auditLogDetailsSchema', () => {
  it('should accept any record', () => {
    const result = auditLogDetailsSchema.parse({
      positionsChecked: 45,
      nested: { deep: true },
    });
    expect(result).toHaveProperty('positionsChecked');
  });

  it('should reject non-object', () => {
    expect(() => auditLogDetailsSchema.parse('string')).toThrow();
  });
});
