/**
 * Centralized catalog of all domain event names.
 * Use these constants when emitting or subscribing to events.
 *
 * Naming Convention:
 * - Event names: dot.notation.lowercase
 * - Constants: UPPER_SNAKE_CASE
 * - Event classes: PascalCase matching the action (e.g., PlatformDegradedEvent)
 *
 * IMPORTANT: Events marked with [Epic X] are placeholders for future implementation.
 * Only Epic 1 events have corresponding event classes in this story.
 */

export const EVENT_NAMES = {
  // ============================================================================
  // EPIC 1 EVENTS (Implemented in this story)
  // ============================================================================

  /** Emitted when platform health status is updated (every 30s) */
  PLATFORM_HEALTH_UPDATED: 'platform.health.updated',

  /** Emitted when platform transitions to degraded state */
  PLATFORM_HEALTH_DEGRADED: 'platform.health.degraded',

  /** Emitted when platform recovers from degraded state to healthy */
  PLATFORM_HEALTH_RECOVERED: 'platform.health.recovered',

  /** Emitted when platform disconnects completely */
  PLATFORM_HEALTH_DISCONNECTED: 'platform.health.disconnected',

  /** Emitted when order book is normalized and persisted */
  ORDERBOOK_UPDATED: 'orderbook.updated',

  /** Emitted when clock drift exceeds 100ms but below 500ms */
  TIME_DRIFT_WARNING: 'time.drift.warning',

  /** Emitted when clock drift exceeds 500ms but below 1000ms */
  TIME_DRIFT_CRITICAL: 'time.drift.critical',

  /** Emitted when clock drift exceeds 1000ms, triggers trading halt */
  TIME_DRIFT_HALT: 'time.drift.halt',

  /** Emitted when trading is halted for any reason (time drift, risk limits, etc.) */
  SYSTEM_TRADING_HALTED: 'system.trading.halted',

  // ============================================================================
  // EPIC 2 EVENTS (Story 2.4 - Degradation Protocol)
  // ============================================================================

  /** Emitted when degradation protocol activates for a platform (81s WebSocket timeout) */
  DEGRADATION_PROTOCOL_ACTIVATED: 'degradation.protocol.activated',

  /** Emitted when degradation protocol deactivates (platform recovered) */
  DEGRADATION_PROTOCOL_DEACTIVATED: 'degradation.protocol.deactivated',

  // ============================================================================
  // FUTURE EVENTS - Placeholders (Epic 3+)
  // ============================================================================
  // NOTE: Event classes for these do NOT exist yet. They will be created in their respective epics.

  // [Epic 3] Detection Events
  /** [Epic 3] Emitted when arbitrage opportunity meets minimum edge threshold */
  OPPORTUNITY_IDENTIFIED: 'detection.opportunity.identified',

  /** [Epic 3] Emitted when opportunity is filtered out (below threshold or insufficient liquidity) */
  OPPORTUNITY_FILTERED: 'detection.opportunity.filtered',

  // [Epic 5] Execution Events
  /** [Epic 5] Emitted when order is filled on a platform */
  ORDER_FILLED: 'execution.order.filled',

  /** [Epic 5] Emitted when execution fails (depth insufficient, order rejected, etc.) */
  EXECUTION_FAILED: 'execution.order.failed',

  /** [Epic 5] Emitted when only one leg fills within timeout */
  SINGLE_LEG_EXPOSURE: 'execution.single_leg.exposure',

  /** [Epic 5] Emitted when exit threshold is hit (take-profit, stop-loss, time-based) */
  EXIT_TRIGGERED: 'execution.exit.triggered',

  // [Epic 4] Risk Events
  /** [Epic 4] Emitted when risk limit is approaching (80% of threshold) */
  LIMIT_APPROACHED: 'risk.limit.approached',

  /** [Epic 4] Emitted when risk limit is breached (trading halt) */
  LIMIT_BREACHED: 'risk.limit.breached',

  /** [Story 4.3] Emitted when operator override is approved */
  OVERRIDE_APPLIED: 'risk.override.applied',

  /** [Story 4.3] Emitted when operator override is denied (daily loss halt) */
  OVERRIDE_DENIED: 'risk.override.denied',

  /** [Story 4.4] Emitted when risk budget is reserved for an opportunity */
  BUDGET_RESERVED: 'risk.budget.reserved',

  /** [Story 4.4] Emitted when budget reservation is committed (execution success) */
  BUDGET_COMMITTED: 'risk.budget.committed',

  /** [Story 4.4] Emitted when budget reservation is released (execution failure) */
  BUDGET_RELEASED: 'risk.budget.released',

  // [All Epics] System Health Events
  /** Emitted when critical system health issue detected (database failure, etc.) */
  SYSTEM_HEALTH_CRITICAL: 'system.health.critical',
} as const;

/**
 * Type-safe event name type derived from EVENT_NAMES object.
 * Ensures only valid event names can be used in emit/subscribe calls.
 */
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];
