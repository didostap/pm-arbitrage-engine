import { describe, it, expect } from 'vitest';
import {
  formatPlatformDegraded,
  formatPlatformRecovered,
  formatOrderbookStale,
  formatOrderbookRecovered,
  formatDataDivergence,
} from './platform-formatters.js';

describe('formatPlatformDegraded', () => {
  it('should show platform and status transition', () => {
    const result = formatPlatformDegraded({
      platformId: 'KALSHI',
      health: { status: 'degraded', latencyMs: 2500 },
      previousStatus: 'healthy',
      timestamp: new Date(),
    });

    expect(result).toContain('<b>Platform Degraded</b>');
    expect(result).toContain('<code>KALSHI</code>');
    expect(result).toContain('2500ms');
  });

  it('should include metadata when present', () => {
    const result = formatPlatformDegraded({
      platformId: 'KALSHI',
      health: {
        status: 'degraded',
        latencyMs: 3000,
        metadata: { errorCode: 'RATE_LIMIT', retryAfter: 30 },
      },
      previousStatus: 'healthy',
      timestamp: new Date(),
    });

    expect(result).toContain('Metadata:');
    expect(result).toContain('RATE_LIMIT');
  });

  it('should omit metadata section when absent', () => {
    const result = formatPlatformDegraded({
      platformId: 'KALSHI',
      health: { status: 'degraded', latencyMs: 2500 },
      previousStatus: 'healthy',
      timestamp: new Date(),
    });

    expect(result).not.toContain('Metadata:');
  });

  it('should handle circular reference in metadata without throwing', () => {
    const circular: Record<string, unknown> = { key: 'value' };
    circular.self = circular;

    const result = formatPlatformDegraded({
      platformId: 'KALSHI',
      health: {
        status: 'degraded',
        latencyMs: 3000,
        metadata: circular,
      },
      previousStatus: 'healthy',
      timestamp: new Date(),
    });

    expect(result).toContain('Metadata:');
    expect(result).toContain('[unserializable]');
  });
});

describe('formatDataDivergence', () => {
  it('should show platform and price delta', () => {
    const result = formatDataDivergence({
      platformId: 'kalshi',
      contractId: 'contract-abc',
      priceDelta: '0.05',
      stalenessDeltaMs: 3000,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F7E1}');
    expect(result).toContain('Data Divergence');
    expect(result).toContain('kalshi');
    expect(result).toContain('contract-abc');
    expect(result).toContain('0.05');
    expect(result).toContain('3000ms');
  });
});

describe('formatPlatformRecovered', () => {
  it('should show recovery details', () => {
    const result = formatPlatformRecovered({
      platformId: 'POLYMARKET',
      health: { status: 'healthy', latencyMs: 100 },
      previousStatus: 'degraded',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F7E2}');
    expect(result).toContain('<b>Platform Recovered</b>');
    expect(result).toContain('POLYMARKET');
  });
});

describe('formatOrderbookStale', () => {
  it('should format orderbook stale event with actionable context', () => {
    const event = {
      platformId: 'kalshi',
      lastUpdateTimestamp: new Date('2026-03-13T10:00:00Z'),
      stalenessMs: 95_000,
      thresholdMs: 90_000,
      timestamp: new Date('2026-03-13T10:01:35Z'),
      correlationId: 'corr-123',
    };

    const result = formatOrderbookStale(event);

    expect(result).toContain('ORDERBOOK STALE');
    expect(result).toContain('kalshi');
    expect(result).toContain('95s');
    expect(result).toContain('2026-03-13T10:00:00.000Z');
    expect(result).toContain('90s');
    expect(result).toContain('Check platform API status');
  });

  it('should handle null lastUpdateTimestamp', () => {
    const event = {
      platformId: 'polymarket',
      lastUpdateTimestamp: null,
      stalenessMs: 100_000,
      thresholdMs: 90_000,
      timestamp: new Date(),
    };

    const result = formatOrderbookStale(event);

    expect(result).toContain('never');
  });
});

describe('formatOrderbookRecovered', () => {
  it('should format orderbook recovered event', () => {
    const event = {
      platformId: 'kalshi',
      recoveryTimestamp: new Date('2026-03-13T10:03:00Z'),
      downtimeMs: 120_000,
      timestamp: new Date('2026-03-13T10:03:00Z'),
      correlationId: 'corr-456',
    };

    const result = formatOrderbookRecovered(event);

    expect(result).toContain('ORDERBOOK RECOVERED');
    expect(result).toContain('kalshi');
    expect(result).toContain('120s');
    expect(result).toContain('2026-03-13T10:03:00.000Z');
    expect(result).toContain('data flow restored');
  });
});
