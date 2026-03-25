import { describe, it, expect } from 'vitest';
import { classifyEventSeverity } from './event-severity.js';

describe('classifyEventSeverity', () => {
  it('should return critical for single leg exposure', () => {
    expect(classifyEventSeverity('execution.single_leg.exposure')).toBe(
      'critical',
    );
  });

  it('should return warning for execution failed', () => {
    expect(classifyEventSeverity('execution.order.failed')).toBe('warning');
  });

  it('should return info for order filled', () => {
    expect(classifyEventSeverity('execution.order.filled')).toBe('info');
  });

  it('should default to info for unknown events', () => {
    expect(classifyEventSeverity('unknown.event')).toBe('info');
  });
});

describe('classifyEventSeverity — Story 8.3 events', () => {
  it('should classify resolution diverged as critical', () => {
    expect(classifyEventSeverity('contract.match.resolution.diverged')).toBe(
      'critical',
    );
  });

  it('should classify resolution poll completed as info', () => {
    expect(
      classifyEventSeverity('contract.match.resolution.poll_completed'),
    ).toBe('info');
  });

  it('should classify calibration completed as info', () => {
    expect(classifyEventSeverity('contract.match.calibration.completed')).toBe(
      'info',
    );
  });

  it('should classify orderbook stale as warning', () => {
    expect(classifyEventSeverity('platform.orderbook.stale')).toBe('warning');
  });

  it('should classify orderbook recovered as info', () => {
    expect(classifyEventSeverity('platform.orderbook.recovered')).toBe('info');
  });
});
