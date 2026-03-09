import { describe, it, expect, vi } from 'vitest';
import { MatchAutoApprovedEvent } from './match-auto-approved.event';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('MatchAutoApprovedEvent', () => {
  it('should create event with all fields', () => {
    const event = new MatchAutoApprovedEvent(
      'match-1',
      92.5,
      'gemini-2.5-flash',
      false,
    );

    expect(event.matchId).toBe('match-1');
    expect(event.confidenceScore).toBe(92.5);
    expect(event.model).toBe('gemini-2.5-flash');
    expect(event.escalated).toBe(false);
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use explicit correlationId when provided', () => {
    const event = new MatchAutoApprovedEvent(
      'match-2',
      90,
      'claude-haiku-4-5-20251001',
      true,
      'explicit-corr-id',
    );

    expect(event.correlationId).toBe('explicit-corr-id');
    expect(event.escalated).toBe(true);
    expect(event.model).toBe('claude-haiku-4-5-20251001');
  });

  it('should have escalated field', () => {
    const event = new MatchAutoApprovedEvent('m', 85, 'model', true);
    expect(event.escalated).toBe(true);
  });
});
