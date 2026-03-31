import { describe, it, expect } from 'vitest';
import { ExternalPairIngestionRunCompletedEvent } from './external-pair-ingestion-run-completed.event';
import { EVENT_NAMES } from './event-catalog';

describe('ExternalPairIngestionRunCompletedEvent', () => {
  it("[P0] EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED should equal 'contract.external-pair-ingestion.run_completed'", () => {
    expect(EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED).toBe(
      'contract.external-pair-ingestion.run_completed',
    );
  });

  it('[P0] event should carry sources array with per-source stats + durationMs', () => {
    const event = new ExternalPairIngestionRunCompletedEvent(
      [
        {
          source: 'predexon',
          fetched: 50,
          deduplicated: 10,
          scored: 40,
          autoApproved: 30,
          pendingReview: 5,
          autoRejected: 5,
          scoringFailures: 0,
          unresolvable: 0,
        },
      ],
      1234,
    );

    expect(event.sources).toHaveLength(1);
    expect(event.sources[0]).toEqual(
      expect.objectContaining({
        source: 'predexon',
        fetched: 50,
        deduplicated: 10,
        scored: 40,
        autoApproved: 30,
        pendingReview: 5,
        autoRejected: 5,
        scoringFailures: 0,
        unresolvable: 0,
      }),
    );
    expect(event.durationMs).toBe(1234);
  });

  it('[P1] event class should extend BaseEvent with correct eventName property', () => {
    const event = new ExternalPairIngestionRunCompletedEvent([], 0);
    expect(event.eventName).toBe(
      'contract.external-pair-ingestion.run_completed',
    );
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});
