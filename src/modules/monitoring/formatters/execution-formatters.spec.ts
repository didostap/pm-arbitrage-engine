import { describe, it, expect } from 'vitest';
import {
  formatOrderFilled,
  formatExecutionFailed,
  formatSingleLegExposure,
  formatSingleLegResolved,
} from './execution-formatters.js';
import { formatOpportunityIdentified } from './detection-formatters.js';
import { formatTradingHalted } from './system-formatters.js';

describe('formatOrderFilled', () => {
  it('should produce correct HTML with paper mode tag', () => {
    const result = formatOrderFilled({
      orderId: 'ord-1',
      platform: 'KALSHI',
      side: 'BUY',
      price: 0.55,
      size: 10,
      fillPrice: 0.56,
      fillSize: 10,
      positionId: 'pos-1',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      correlationId: 'corr-456',
      isPaper: true,
      mixedMode: false,
    });

    expect(result).toContain('[PAPER]');
    expect(result).toContain('<b>Order Filled</b>');
    expect(result).toContain('<code>KALSHI</code>');
    expect(result).toContain('<code>0.5600</code>'); // fillPrice
    expect(result).toContain('Slippage');
  });
});

describe('formatExecutionFailed', () => {
  it('should show warning emoji and error details', () => {
    const result = formatExecutionFailed({
      reasonCode: 2001,
      reason: 'Insufficient depth',
      opportunityId: 'opp-1',
      context: {},
      timestamp: new Date(),
      correlationId: 'corr-789',
    });

    expect(result).toContain('\u{1F7E1}'); // yellow emoji (warning)
    expect(result).toContain('<b>Execution Failed</b>');
    expect(result).toContain('<code>2001</code>');
    expect(result).toContain('Insufficient depth');
  });

  it('should include context when non-empty', () => {
    const result = formatExecutionFailed({
      reasonCode: 2001,
      reason: 'Timeout',
      opportunityId: 'opp-1',
      context: { retryCount: 3, timeout: true },
      timestamp: new Date(),
    });

    expect(result).toContain('Context:');
    expect(result).toContain('retryCount');
    expect(result).toContain('3');
  });

  it('should omit context section when empty', () => {
    const result = formatExecutionFailed({
      reasonCode: 2001,
      reason: 'Timeout',
      opportunityId: 'opp-1',
      context: {},
      timestamp: new Date(),
    });

    expect(result).not.toContain('Context:');
  });

  it('should render null/undefined context values as N/A', () => {
    const result = formatExecutionFailed({
      reasonCode: 2001,
      reason: 'Timeout',
      opportunityId: 'opp-1',
      context: { nullField: null, undefinedField: undefined },
      timestamp: new Date(),
    });

    expect(result).toContain('Context:');
    expect(result).toContain('nullField');
    expect(result).toContain('N/A');
    expect(result).not.toContain('>null<');
    expect(result).not.toContain('>undefined<');
  });
});

describe('formatSingleLegExposure', () => {
  it('should show URGENT header and full context', () => {
    const result = formatSingleLegExposure({
      positionId: 'pos-1',
      pairId: 'pair-1',
      expectedEdge: 0.012,
      filledLeg: {
        platform: 'KALSHI',
        orderId: 'ord-1',
        side: 'BUY',
        price: 0.55,
        size: 10,
        fillPrice: 0.56,
        fillSize: 10,
      },
      failedLeg: {
        platform: 'POLYMARKET',
        reason: 'Timeout',
        reasonCode: 1009,
        attemptedPrice: 0.45,
        attemptedSize: 10,
      },
      pnlScenarios: {
        closeNowEstimate: '-$2.50',
        retryAtCurrentPrice: '+$1.20',
        holdRiskAssessment: 'Moderate',
      },
      recommendedActions: ['Retry second leg', 'Close position'],
      timestamp: new Date(),
      correlationId: 'corr-urg',
    });

    expect(result).toContain('\u{1F534}'); // red emoji (critical)
    expect(result).toContain('SINGLE LEG EXPOSURE');
    expect(result).toContain('Filled Leg');
    expect(result).toContain('Failed Leg');
    expect(result).toContain('P&amp;L Scenarios');
    expect(result).toContain('Retry second leg');
    // Finding 8: attempted price and size should be displayed
    expect(result).toContain('0.4500');
    expect(result).toContain('Attempted');
  });
});

describe('formatSingleLegResolved', () => {
  it('should show resolution details', () => {
    const result = formatSingleLegResolved({
      positionId: 'pos-1',
      pairId: 'pair-1',
      resolutionType: 'retried',
      resolvedOrder: {
        orderId: 'ord-2',
        platform: 'POLYMARKET',
        status: 'FILLED',
        filledPrice: 0.45,
        filledQuantity: 10,
      },
      originalEdge: 0.012,
      newEdge: 0.01,
      realizedPnl: null,
      timestamp: new Date(),
    });

    expect(result).toContain('<b>Single Leg Resolved</b>');
    expect(result).toContain('<code>retried</code>');
    expect(result).toContain('New Edge');
  });
});

describe('HTML escaping in formatters prevents injection', () => {
  it('should escape malicious content in opportunity data', () => {
    const result = formatOpportunityIdentified({
      opportunity: { netEdge: '<script>alert(1)</script>' },
      timestamp: new Date(),
    });
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('correlationId inclusion', () => {
  it('should include correlationId when present', () => {
    const result = formatOrderFilled({
      orderId: 'ord-1',
      platform: 'KALSHI',
      side: 'BUY',
      price: 0.5,
      size: 10,
      fillPrice: 0.5,
      fillSize: 10,
      positionId: 'pos-1',
      timestamp: new Date(),
      correlationId: 'test-corr-id',
    });
    expect(result).toContain('test-corr-id');
  });

  it('should not include correlation line when absent', () => {
    const result = formatOrderFilled({
      orderId: 'ord-1',
      platform: 'KALSHI',
      side: 'BUY',
      price: 0.5,
      size: 10,
      fillPrice: 0.5,
      fillSize: 10,
      positionId: 'pos-1',
      timestamp: new Date(),
    });
    expect(result).not.toContain('Correlation:');
  });
});

describe('timestamps in ISO format', () => {
  it('should include ISO timestamp', () => {
    const date = new Date('2024-06-15T14:30:00.000Z');
    const result = formatTradingHalted({
      reason: 'test',
      details: {},
      haltTimestamp: date,
      severity: 'critical',
      timestamp: date,
    });
    expect(result).toContain('2024-06-15T14:30:00.000Z');
  });
});
