import { describe, it, expect } from 'vitest';
import { formatOpportunityIdentified } from './detection-formatters.js';

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
