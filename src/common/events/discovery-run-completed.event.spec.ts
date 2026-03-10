import { DiscoveryRunCompletedEvent } from './discovery-run-completed.event';
import type { DiscoveryRunStats } from './discovery-run-completed.event';

describe('DiscoveryRunCompletedEvent', () => {
  const stats: DiscoveryRunStats = {
    catalogsFetched: 2,
    candidatesPreFiltered: 15,
    pairsScored: 8,
    autoApproved: 5,
    autoRejected: 2,
    pendingReview: 3,
    scoringFailures: 0,
    durationMs: 12345,
  };

  it('should construct with stats', () => {
    const event = new DiscoveryRunCompletedEvent(stats);
    expect(event.stats).toEqual(stats);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('should accept optional correlationId', () => {
    const event = new DiscoveryRunCompletedEvent(stats, 'corr-123');
    expect(event.correlationId).toBe('corr-123');
  });

  it('should expose all stat fields', () => {
    const event = new DiscoveryRunCompletedEvent(stats);
    expect(event.stats.catalogsFetched).toBe(2);
    expect(event.stats.candidatesPreFiltered).toBe(15);
    expect(event.stats.pairsScored).toBe(8);
    expect(event.stats.autoApproved).toBe(5);
    expect(event.stats.autoRejected).toBe(2);
    expect(event.stats.pendingReview).toBe(3);
    expect(event.stats.scoringFailures).toBe(0);
    expect(event.stats.durationMs).toBe(12345);
  });
});
