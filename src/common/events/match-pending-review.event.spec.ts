import { describe, it, expect, vi } from 'vitest';
import { MatchPendingReviewEvent } from './match-pending-review.event';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('MatchPendingReviewEvent', () => {
  it('should create event with all fields', () => {
    const event = new MatchPendingReviewEvent(
      'match-1',
      72.3,
      'gemini-2.5-flash',
      false,
    );

    expect(event.matchId).toBe('match-1');
    expect(event.confidenceScore).toBe(72.3);
    expect(event.model).toBe('gemini-2.5-flash');
    expect(event.escalated).toBe(false);
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use explicit correlationId when provided', () => {
    const event = new MatchPendingReviewEvent(
      'match-2',
      40,
      'claude-haiku-4-5-20251001',
      true,
      'explicit-corr-id',
    );

    expect(event.correlationId).toBe('explicit-corr-id');
    expect(event.escalated).toBe(true);
  });

  it('should have escalated field', () => {
    const event = new MatchPendingReviewEvent('m', 50, 'model', true);
    expect(event.escalated).toBe(true);
  });
});
