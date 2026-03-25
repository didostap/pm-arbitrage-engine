import { describe, it, expect } from 'vitest';
import {
  formatLimitApproached,
  formatLimitBreached,
  formatClusterLimitBreached,
  formatAggregateClusterLimitBreached,
  formatBankrollUpdated,
} from './risk-formatters.js';

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

  it('should escape breach value for defense-in-depth', () => {
    const result = formatLimitBreached({
      limitType: 'daily_loss',
      currentValue: 600,
      threshold: 500,
      timestamp: new Date(),
    });
    // Decimal output should be escaped (defense-in-depth)
    expect(result).toContain('100.00');
    expect(result).not.toContain('<script>');
  });
});

describe('formatClusterLimitBreached', () => {
  it('should show cluster name and exposure', () => {
    const result = formatClusterLimitBreached({
      clusterName: 'politics',
      clusterId: 'cluster-1',
      currentExposurePct: 0.18,
      hardLimitPct: 0.15,
      triageRecommendations: [
        {
          positionId: 'pos-1',
          pairId: 'pair-1',
          expectedEdge: '0.012',
          capitalDeployed: '500',
          suggestedAction: 'close',
          reason: 'lowest edge',
        },
      ],
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('CLUSTER LIMIT BREACHED');
    expect(result).toContain('politics');
    expect(result).toContain('18.0%');
    expect(result).toContain('15%');
    expect(result).toContain('Triage');
    expect(result).toContain('$500');
  });

  it('should escape triage recommendation values', () => {
    const result = formatClusterLimitBreached({
      clusterName: 'test',
      clusterId: 'c-1',
      currentExposurePct: 0.2,
      hardLimitPct: 0.15,
      triageRecommendations: [
        {
          positionId: 'pos-1',
          pairId: 'pair-1',
          expectedEdge: '<script>xss</script>',
          capitalDeployed: '<img onerror=alert(1)>',
          suggestedAction: 'close',
          reason: 'test',
        },
      ],
      timestamp: new Date(),
    });

    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });
});

describe('formatAggregateClusterLimitBreached', () => {
  it('should show aggregate exposure and limit', () => {
    const result = formatAggregateClusterLimitBreached({
      aggregateExposurePct: 0.55,
      aggregateLimitPct: 0.5,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('AGGREGATE CLUSTER LIMIT BREACHED');
    expect(result).toContain('55.0%');
    expect(result).toContain('50%');
    expect(result).toContain('No new positions');
  });
});

describe('formatBankrollUpdated', () => {
  it('should show previous and new values', () => {
    const result = formatBankrollUpdated({
      previousValue: '10000',
      newValue: '15000',
      updatedBy: 'operator',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F7E1}');
    expect(result).toContain('Bankroll Updated');
    expect(result).toContain('$10000');
    expect(result).toContain('$15000');
    expect(result).toContain('operator');
  });
});
