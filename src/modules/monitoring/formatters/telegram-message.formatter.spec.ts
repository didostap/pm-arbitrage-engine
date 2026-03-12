import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  smartTruncate,
  formatOpportunityIdentified,
  formatOrderFilled,
  formatExecutionFailed,
  formatSingleLegExposure,
  formatSingleLegResolved,
  formatExitTriggered,
  formatLimitApproached,
  formatLimitBreached,
  formatPlatformDegraded,
  formatPlatformRecovered,
  formatTradingHalted,
  formatTradingResumed,
  formatReconciliationDiscrepancy,
  formatSystemHealthCritical,
  formatTestAlert,
  formatResolutionDivergence,
  formatResolutionPollCompleted,
  formatCalibrationCompleted,
  formatOrderbookStale,
  formatOrderbookRecovered,
  getEventSeverity,
} from './telegram-message.formatter.js';

describe('escapeHtml', () => {
  it('should escape <, >, and &', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;',
    );
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });
});

describe('smartTruncate', () => {
  it('should return text unchanged if under 4096 chars', () => {
    const text = 'Short message';
    expect(smartTruncate(text)).toBe(text);
  });

  it('should truncate at 4096 chars preserving header and footer', () => {
    const header = '<b>Header</b>\n'.repeat(30); // ~420 chars
    const middle = 'x'.repeat(4000);
    const footer =
      '\nCorrelation: <code>abc-123</code>\nTime: <code>2024-01-01T00:00:00.000Z</code>';
    const text = header + middle + footer;

    const result = smartTruncate(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('[...truncated...]');
  });

  it('should close unclosed HTML tags after truncation', () => {
    const text = '<b>' + 'x'.repeat(5000) + '</b>';
    const result = smartTruncate(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    // Should have closing </b> tag
    expect(result).toContain('</b>');
  });
});

describe('formatOpportunityIdentified', () => {
  it('should produce correct HTML structure', () => {
    const result = formatOpportunityIdentified({
      opportunity: {
        netEdge: 0.0125,
        pairId: 'pair-1',
        positionSizeUsd: 300,
      },
      timestamp: new Date('2024-01-15T10:30:00Z'),
      correlationId: 'corr-123',
    });

    expect(result).toContain('\u{1F7E2}'); // green emoji (info)
    expect(result).toContain('<b>Opportunity Identified</b>');
    expect(result).toContain('<code>0.0125</code>');
    expect(result).toContain('<code>pair-1</code>');
    expect(result).toContain('<code>corr-123</code>');
  });
});

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

describe('formatExitTriggered', () => {
  it('should show exit type and P&L', () => {
    const result = formatExitTriggered({
      positionId: 'pos-1',
      pairId: 'pair-1',
      exitType: 'take_profit',
      initialEdge: '0.0120',
      finalEdge: '0.0005',
      realizedPnl: '+$3.50',
      kalshiCloseOrderId: 'k-close-1',
      polymarketCloseOrderId: 'p-close-1',
      timestamp: new Date(),
    });

    expect(result).toContain('Take Profit');
    expect(result).toContain('+$3.50');
  });
});

describe('formatLimitApproached', () => {
  it('should show utilization percentage', () => {
    const result = formatLimitApproached({
      limitType: 'daily_loss',
      currentValue: 400,
      threshold: 500,
      percentUsed: 80,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F7E1}');
    expect(result).toContain('Risk Limit Approaching');
    expect(result).toContain('80.0%');
  });
});

describe('formatLimitBreached', () => {
  it('should show URGENT header and breach amount', () => {
    const result = formatLimitBreached({
      limitType: 'daily_loss',
      currentValue: 550,
      threshold: 500,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('RISK LIMIT BREACHED');
    expect(result).toContain('50.00');
  });
});

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

describe('formatTradingHalted', () => {
  it('should show URGENT header', () => {
    const result = formatTradingHalted({
      reason: 'DAILY_LOSS_LIMIT',
      details: {},
      haltTimestamp: new Date('2024-01-15T10:30:00Z'),
      severity: 'critical',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('TRADING HALTED');
    expect(result).toContain('DAILY_LOSS_LIMIT');
  });
});

describe('formatTradingResumed', () => {
  it('should show removed reason and remaining', () => {
    const result = formatTradingResumed({
      removedReason: 'DAILY_LOSS_LIMIT',
      remainingReasons: [],
      resumeTimestamp: new Date('2024-01-15T12:00:00Z'),
      timestamp: new Date(),
    });

    expect(result).toContain('<b>Trading Resumed</b>');
    expect(result).toContain('No remaining halt reasons');
  });
});

describe('formatReconciliationDiscrepancy', () => {
  it('should show discrepancy details', () => {
    const result = formatReconciliationDiscrepancy({
      positionId: 'pos-1',
      pairId: 'pair-1',
      discrepancyType: 'order_status_mismatch',
      localState: 'FILLED',
      platformState: 'PENDING',
      recommendedAction: 'Manual review required',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('Reconciliation Discrepancy');
    expect(result).toContain('order_status_mismatch');
  });
});

describe('formatSystemHealthCritical', () => {
  it('should show component and actions', () => {
    const result = formatSystemHealthCritical({
      component: 'database',
      diagnosticInfo: 'Connection pool exhausted',
      recommendedActions: ['Restart connection pool', 'Check DB load'],
      severity: 'critical',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('System Health Critical');
    expect(result).toContain('<code>database</code>');
    expect(result).toContain('Restart connection pool');
  });
});

describe('formatTestAlert', () => {
  it('should produce health check message with uptime', () => {
    const result = formatTestAlert();
    expect(result).toContain('\u{1F7E2}');
    expect(result).toContain('Daily Test Alert');
    expect(result).toContain('Alerting system healthy');
    expect(result).toContain('Timestamp');
    expect(result).toContain('Uptime:');
  });
});

describe('getEventSeverity', () => {
  it('should return critical for single leg exposure', () => {
    expect(getEventSeverity('execution.single_leg.exposure')).toBe('critical');
  });

  it('should return warning for execution failed', () => {
    expect(getEventSeverity('execution.order.failed')).toBe('warning');
  });

  it('should return info for order filled', () => {
    expect(getEventSeverity('execution.order.filled')).toBe('info');
  });

  it('should default to info for unknown events', () => {
    expect(getEventSeverity('unknown.event')).toBe('info');
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

describe('formatResolutionDivergence', () => {
  it('should format divergence alert with match details', () => {
    const result = formatResolutionDivergence({
      matchId: 'match-123',
      polymarketResolution: 'yes',
      kalshiResolution: 'no',
      divergenceNotes: null,
      timestamp: new Date(),
    });
    expect(result).toContain('RESOLUTION DIVERGED');
    expect(result).toContain('match-123');
    expect(result).toContain('yes');
    expect(result).toContain('no');
    expect(result).toContain('root cause');
  });
});

describe('formatResolutionPollCompleted', () => {
  it('should format poll summary with no divergence', () => {
    const result = formatResolutionPollCompleted({
      stats: {
        totalChecked: 5,
        newlyResolved: 2,
        diverged: 0,
        skippedInvalid: 0,
        pendingOnePlatform: 3,
        errors: 0,
      },
      timestamp: new Date(),
    });
    expect(result).toContain('Resolution Poll');
    expect(result).toContain('5');
    expect(result).toContain('2');
  });

  it('should escalate when divergence detected', () => {
    const result = formatResolutionPollCompleted({
      stats: {
        totalChecked: 10,
        newlyResolved: 5,
        diverged: 2,
        skippedInvalid: 0,
        pendingOnePlatform: 3,
        errors: 0,
      },
      timestamp: new Date(),
    });
    expect(result).toContain('⚠️');
    expect(result).toContain('Diverged');
  });
});

describe('formatCalibrationCompleted', () => {
  it('should format calibration analysis with tiers', () => {
    const result = formatCalibrationCompleted({
      calibrationResult: {
        totalResolvedMatches: 50,
        minimumDataMet: true,
        tiers: {
          autoApprove: { matchCount: 30, divergenceRate: 0 },
          pendingReview: { matchCount: 15, divergenceRate: 6.7 },
          autoReject: { matchCount: 5, divergenceRate: 0 },
        },
        recommendations: ['Consider lowering threshold'],
      },
      timestamp: new Date(),
    });
    expect(result).toContain('Calibration Analysis');
    expect(result).toContain('50');
    expect(result).toContain('30');
    expect(result).toContain('Recommendations');
  });

  it('should show insufficient data', () => {
    const result = formatCalibrationCompleted({
      calibrationResult: {
        totalResolvedMatches: 3,
        minimumDataMet: false,
        tiers: {
          autoApprove: { matchCount: 0, divergenceRate: 0 },
          pendingReview: { matchCount: 0, divergenceRate: 0 },
          autoReject: { matchCount: 0, divergenceRate: 0 },
        },
        recommendations: [],
      },
      timestamp: new Date(),
    });
    expect(result).toContain('no');
    expect(result).toContain('3');
  });
});

describe('getEventSeverity — Story 8.3 events', () => {
  it('should classify resolution diverged as critical', () => {
    expect(getEventSeverity('contract.match.resolution.diverged')).toBe(
      'critical',
    );
  });

  it('should classify resolution poll completed as info', () => {
    expect(getEventSeverity('contract.match.resolution.poll_completed')).toBe(
      'info',
    );
  });

  it('should classify calibration completed as info', () => {
    expect(getEventSeverity('contract.match.calibration.completed')).toBe(
      'info',
    );
  });

  it('should classify orderbook stale as warning', () => {
    expect(getEventSeverity('platform.orderbook.stale')).toBe('warning');
  });

  it('should classify orderbook recovered as info', () => {
    expect(getEventSeverity('platform.orderbook.recovered')).toBe('info');
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
