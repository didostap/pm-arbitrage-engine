import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import type { NormalizedHistoricalDepth } from './normalized-historical.types';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

describe('NormalizedHistoricalDepth type (Story 10-9-1b)', () => {
  it('[P1] should construct NormalizedHistoricalDepth with Decimal bids/asks arrays', () => {
    const depth: NormalizedHistoricalDepth = {
      platform: 'polymarket',
      contractId: '0xTokenABC',
      source: 'PMXT_ARCHIVE',
      bids: [
        { price: new Decimal('0.55'), size: new Decimal('100') },
        { price: new Decimal('0.54'), size: new Decimal('80') },
      ],
      asks: [
        { price: new Decimal('0.60'), size: new Decimal('90') },
        { price: new Decimal('0.61'), size: new Decimal('70') },
      ],
      timestamp: new Date('2025-06-01T12:00:00Z'),
      updateType: 'snapshot',
    };

    expect(depth.bids[0]!.price).toBeInstanceOf(Decimal);
    expect(depth.bids[0]!.size).toBeInstanceOf(Decimal);
    expect(depth.asks[0]!.price).toBeInstanceOf(Decimal);
    expect(depth.asks[0]!.size).toBeInstanceOf(Decimal);
    expect(depth.platform).toBe('polymarket');
    expect(depth.source).toBe('PMXT_ARCHIVE');
    expect(depth.updateType).toBe('snapshot');
  });

  it('[P1] should support null updateType for sources without update classification', () => {
    const depth: NormalizedHistoricalDepth = {
      platform: 'polymarket',
      contractId: '0xTokenABC',
      source: 'PMXT_ARCHIVE',
      bids: [],
      asks: [],
      timestamp: new Date('2025-06-01T12:00:00Z'),
      updateType: null,
    };

    expect(depth.updateType).toBeNull();
  });
});

describe('DataQualityFlags depth extensions (Story 10-9-1b)', () => {
  it('[P1] should include hasWideSpreads boolean field', () => {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
      hasWideSpreads: true,
      spreadDetails: [
        { timestamp: new Date('2025-06-01T12:00:00Z'), spreadBps: 1000 },
      ],
    };

    expect(flags.hasWideSpreads).toBe(true);
    expect(flags.spreadDetails).toHaveLength(1);
    expect(flags.spreadDetails![0]).toEqual(
      expect.objectContaining({
        timestamp: expect.any(Date),
        spreadBps: expect.any(Number),
      }),
    );
  });

  it('[P1] should be backward-compatible (depth fields optional)', () => {
    const legacyFlags: DataQualityFlags = {
      hasGaps: true,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [{ from: new Date(), to: new Date() }],
      jumpDetails: [],
    };

    expect(legacyFlags.hasGaps).toBe(true);
    expect(legacyFlags.hasWideSpreads).toBeUndefined();
  });
});
