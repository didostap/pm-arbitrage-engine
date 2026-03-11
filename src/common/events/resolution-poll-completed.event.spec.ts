import { ResolutionPollCompletedEvent } from './resolution-poll-completed.event';
import type { ResolutionPollStats } from './resolution-poll-completed.event';

describe('ResolutionPollCompletedEvent', () => {
  const stats: ResolutionPollStats = {
    totalChecked: 10,
    newlyResolved: 3,
    diverged: 1,
    skippedInvalid: 0,
    pendingOnePlatform: 2,
    errors: 1,
  };

  it('should construct with stats', () => {
    const event = new ResolutionPollCompletedEvent(stats);
    expect(event.stats).toEqual(stats);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('should accept optional correlationId', () => {
    const event = new ResolutionPollCompletedEvent(stats, 'corr-456');
    expect(event.correlationId).toBe('corr-456');
  });

  it('should expose all stat fields', () => {
    const event = new ResolutionPollCompletedEvent(stats);
    expect(event.stats.totalChecked).toBe(10);
    expect(event.stats.newlyResolved).toBe(3);
    expect(event.stats.diverged).toBe(1);
    expect(event.stats.skippedInvalid).toBe(0);
    expect(event.stats.pendingOnePlatform).toBe(2);
    expect(event.stats.errors).toBe(1);
  });
});
