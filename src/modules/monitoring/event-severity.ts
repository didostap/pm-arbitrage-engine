import { EVENT_NAMES } from '../../common/events/event-catalog.js';

export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Centralized severity classification for ALL domain events.
 * Single source of truth — used by event-consumer, telegram-alert, and formatters.
 */
const CRITICAL_EVENTS = new Set<string>([
  EVENT_NAMES.SINGLE_LEG_EXPOSURE,
  EVENT_NAMES.LIMIT_BREACHED,
  EVENT_NAMES.SYSTEM_TRADING_HALTED,
  EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
  EVENT_NAMES.RECONCILIATION_DISCREPANCY,
  EVENT_NAMES.TIME_DRIFT_HALT,
  EVENT_NAMES.RESOLUTION_DIVERGED,
  EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
  EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
]);

const WARNING_EVENTS = new Set<string>([
  EVENT_NAMES.EXECUTION_FAILED,
  EVENT_NAMES.LIMIT_APPROACHED,
  EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
  EVENT_NAMES.TIME_DRIFT_CRITICAL,
  EVENT_NAMES.TIME_DRIFT_WARNING,
  EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED,
  EVENT_NAMES.ORDERBOOK_STALE,
  EVENT_NAMES.DATA_DIVERGENCE,
  EVENT_NAMES.DATA_FALLBACK,
]);

export function classifyEventSeverity(eventName: string): AlertSeverity {
  if (CRITICAL_EVENTS.has(eventName)) return 'critical';
  if (WARNING_EVENTS.has(eventName)) return 'warning';
  return 'info';
}
