import { describe, it, expect, vi } from 'vitest';
import {
  ReconciliationCompleteEvent,
  ReconciliationDiscrepancyEvent,
} from './system.events';
import { EVENT_NAMES } from './event-catalog';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ReconciliationCompleteEvent', () => {
  it('should construct with all required fields', () => {
    const event = new ReconciliationCompleteEvent(
      5,
      12,
      3,
      1,
      1500,
      'Reconciliation complete: 5 positions checked, 1 discrepancy found',
    );

    expect(event.positionsChecked).toBe(5);
    expect(event.ordersVerified).toBe(12);
    expect(event.pendingOrdersResolved).toBe(3);
    expect(event.discrepanciesFound).toBe(1);
    expect(event.durationMs).toBe(1500);
    expect(event.summary).toBe(
      'Reconciliation complete: 5 positions checked, 1 discrepancy found',
    );
  });

  it('should inherit BaseEvent timestamp and correlationId', () => {
    const event = new ReconciliationCompleteEvent(0, 0, 0, 0, 100, 'Clean');

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use provided correlationId when given', () => {
    const event = new ReconciliationCompleteEvent(
      0,
      0,
      0,
      0,
      100,
      'Clean',
      'custom-corr-id',
    );

    expect(event.correlationId).toBe('custom-corr-id');
  });

  it('should match EVENT_NAMES.RECONCILIATION_COMPLETE catalog entry', () => {
    expect(EVENT_NAMES.RECONCILIATION_COMPLETE).toBe(
      'system.reconciliation.complete',
    );
  });
});

describe('ReconciliationDiscrepancyEvent', () => {
  it('should construct with order_status_mismatch type', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-1',
      'pair-1',
      'order_status_mismatch',
      'pending',
      'filled',
      'Update local order status to filled',
    );

    expect(event.positionId).toBe('pos-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.discrepancyType).toBe('order_status_mismatch');
    expect(event.localState).toBe('pending');
    expect(event.platformState).toBe('filled');
    expect(event.recommendedAction).toBe('Update local order status to filled');
  });

  it('should construct with order_not_found type', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-2',
      'pair-2',
      'order_not_found',
      'pending',
      'not_found',
      'Flag for manual review',
    );

    expect(event.discrepancyType).toBe('order_not_found');
  });

  it('should construct with pending_filled type', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-3',
      'pair-3',
      'pending_filled',
      'pending',
      'filled',
      'Update to filled and recalculate exposure',
    );

    expect(event.discrepancyType).toBe('pending_filled');
  });

  it('should construct with platform_unavailable type', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-4',
      'pair-4',
      'platform_unavailable',
      'pending',
      'unknown',
      'Retry when platform recovers',
    );

    expect(event.discrepancyType).toBe('platform_unavailable');
  });

  it('should inherit BaseEvent timestamp and correlationId', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-1',
      'pair-1',
      'order_status_mismatch',
      'pending',
      'filled',
      'Update',
    );

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use provided correlationId when given', () => {
    const event = new ReconciliationDiscrepancyEvent(
      'pos-1',
      'pair-1',
      'order_status_mismatch',
      'pending',
      'filled',
      'Update',
      'custom-corr-id',
    );

    expect(event.correlationId).toBe('custom-corr-id');
  });

  it('should match EVENT_NAMES.RECONCILIATION_DISCREPANCY catalog entry', () => {
    expect(EVENT_NAMES.RECONCILIATION_DISCREPANCY).toBe(
      'system.reconciliation.discrepancy',
    );
  });
});
