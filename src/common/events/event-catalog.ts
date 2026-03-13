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

  /** [Story 6.5.0a] Emitted when WebSocket data staleness detected (>30s) */
  DATA_STALE: 'platform.health.data-stale',

  /** [Story 9.1b] Emitted when platform orderbook data exceeds staleness threshold */
  ORDERBOOK_STALE: 'platform.orderbook.stale',

  /** [Story 9.1b] Emitted when platform orderbook data resumes after staleness */
  ORDERBOOK_RECOVERED: 'platform.orderbook.recovered',

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

  /** Emitted when a specific halt reason is removed and trading may resume */
  SYSTEM_TRADING_RESUMED: 'system.trading.resumed',

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

  /** [Story 6.5.0a] Emitted when depth verification fails due to API error */
  DEPTH_CHECK_FAILED: 'execution.depth-check.failed',

  /** [Epic 5] Emitted when only one leg fills within timeout */
  SINGLE_LEG_EXPOSURE: 'execution.single_leg.exposure',

  /** [Story 5.3] Emitted when single-leg exposure is resolved (retried or closed) */
  SINGLE_LEG_RESOLVED: 'execution.single_leg.resolved',

  /** [Story 5.3] Emitted every 60s for unresolved single-leg positions (re-emission, not counted toward thresholds) */
  SINGLE_LEG_EXPOSURE_REMINDER: 'execution.single_leg.exposure_reminder',

  /** [Story 5.4] Emitted when exit threshold is hit (take-profit, stop-loss, time-based) */
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

  /** [Story 9-0-2] Emitted when Prisma JSON field validation fails (data corruption) */
  DATA_CORRUPTION_DETECTED: 'system.data-corruption.detected',

  // [Story 5.5] Reconciliation Events
  /** Emitted when startup reconciliation completes */
  RECONCILIATION_COMPLETE: 'system.reconciliation.complete',

  /** Emitted for each discrepancy found during reconciliation */
  RECONCILIATION_DISCREPANCY: 'system.reconciliation.discrepancy',

  // [Story 6.0] Gas Estimation Events
  /** Emitted when gas estimate changes significantly (>10% delta) */
  PLATFORM_GAS_UPDATED: 'platform.gas.updated',

  // [Story 6.4] Compliance Events
  /** Emitted when trade is blocked by compliance validation */
  COMPLIANCE_BLOCKED: 'execution.compliance.blocked',

  // [Story 6.5] Audit Events
  /** Emitted when audit log write fails */
  AUDIT_LOG_FAILED: 'monitoring.audit.write_failed',
  /** Emitted when hash chain integrity check fails */
  AUDIT_CHAIN_BROKEN: 'monitoring.audit.chain_broken',

  // [Story 7.3] Contract Match Approval Events
  /** Emitted when operator approves a contract match */
  MATCH_APPROVED: 'contract.match.approved',
  /** Emitted when operator rejects a contract match */
  MATCH_REJECTED: 'contract.match.rejected',

  // [Story 7.5.3] Batch Close Events
  /** Emitted when a batch close-all operation completes */
  BATCH_COMPLETE: 'execution.batch.complete',

  // [Story 8.1] Resolution Tracking Events
  /** Emitted when resolution outcomes diverge between platforms */
  RESOLUTION_DIVERGED: 'contract.match.resolution.diverged',

  // [Story 8.2] Confidence Scoring Events
  /** Emitted when a contract match is auto-approved by confidence scorer */
  MATCH_AUTO_APPROVED: 'contract.match.auto_approved',
  /** Emitted when a contract match needs operator review (below auto-approve threshold) */
  MATCH_PENDING_REVIEW: 'contract.match.pending_review',

  // [Story 8.4] Discovery Pipeline Events
  /** Emitted when a discovery run completes (success or partial failure) */
  DISCOVERY_RUN_COMPLETED: 'contract.discovery.run_completed',

  // [Story 8.3] Resolution Feedback Loop Events
  /** Emitted when the resolution poller completes a run */
  RESOLUTION_POLL_COMPLETED: 'contract.match.resolution.poll_completed',
  /** Emitted when calibration analysis completes */
  CALIBRATION_COMPLETED: 'contract.match.calibration.completed',

  // [Story 9.1] Correlation Cluster Events
  /** Emitted when any cluster's exposure approaches the hard limit (12% soft threshold) */
  CLUSTER_LIMIT_APPROACHED: 'risk.cluster.limit_approached',
  /** Emitted when operator overrides a cluster assignment */
  CLUSTER_OVERRIDE: 'risk.cluster.override',
  /** Emitted when a contract match is assigned to a cluster */
  CLUSTER_ASSIGNED: 'risk.cluster.assigned',

  // [Story 9.2] Cluster Limit Enforcement Events
  /** Emitted when a cluster's hard limit (15%) would be breached by a new position */
  CLUSTER_LIMIT_BREACHED: 'risk.cluster.limit_breached',
  /** Emitted when aggregate exposure across all clusters exceeds the aggregate limit (50%) */
  AGGREGATE_CLUSTER_LIMIT_BREACHED: 'risk.cluster.aggregate_breached',
} as const;

/**
 * Type-safe event name type derived from EVENT_NAMES object.
 * Ensures only valid event names can be used in emit/subscribe calls.
 */
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];
