import { describe, it, expect } from 'vitest';
import type { NormalizedHistoricalDepth } from './normalized-historical.types';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

describe('NormalizedHistoricalDepth type (Story 10-9-1b)', () => {
  it('[P1] should construct NormalizedHistoricalDepth with number bids/asks arrays', () => {
    const depth: NormalizedHistoricalDepth = {
      platform: 'polymarket',
      contractId: '0xTokenABC',
      source: 'PMXT_ARCHIVE',
      bids: [
        { price: 0.55, size: 100 },
        { price: 0.54, size: 80 },
      ],
      asks: [
        { price: 0.6, size: 90 },
        { price: 0.61, size: 70 },
      ],
      timestamp: new Date('2025-06-01T12:00:00Z'),
      updateType: 'snapshot',
    };

    expect(typeof depth.bids[0]!.price).toBe('number');
    expect(typeof depth.bids[0]!.size).toBe('number');
    expect(typeof depth.asks[0]!.price).toBe('number');
    expect(typeof depth.asks[0]!.size).toBe('number');
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
      hasCrossedBooks: false,
    };
    expect(flags.hasWideSpreads).toBe(true);
  });

  it('[P1] should include hasCrossedBooks boolean field', () => {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
      hasWideSpreads: false,
      hasCrossedBooks: true,
    };
    expect(flags.hasCrossedBooks).toBe(true);
  });
});
