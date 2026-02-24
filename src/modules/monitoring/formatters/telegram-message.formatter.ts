import Decimal from 'decimal.js';
import { BaseEvent } from '../../../common/events/base.event.js';

export type AlertSeverity = 'critical' | 'warning' | 'info';

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '\u{1F534}',
  warning: '\u{1F7E1}',
  info: '\u{1F7E2}',
};

const MAX_MESSAGE_LENGTH = 4096;
const HEADER_RESERVE = 500;
const FOOTER_RESERVE = 200;

/**
 * Escape HTML special characters in dynamic values.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Smart truncation preserving header and footer.
 * Ensures no unclosed HTML tags.
 */
export function smartTruncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;

  const header = text.slice(0, HEADER_RESERVE);
  const footer = text.slice(-FOOTER_RESERVE);
  const truncationMarker = '\n[...truncated...]\n';

  const available = MAX_MESSAGE_LENGTH - truncationMarker.length;
  const headerPart = header.slice(
    0,
    Math.min(header.length, available - FOOTER_RESERVE),
  );
  const footerPart = footer.slice(
    Math.max(0, footer.length - (available - headerPart.length)),
  );

  let result = headerPart + truncationMarker + footerPart;

  // Close any unclosed tags
  result = closeUnclosedTags(result);

  return result.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Naive tag closer: finds opened tags without matching close tags and appends closers.
 */
function closeUnclosedTags(html: string): string {
  const openTagRegex = /<(b|i|code|pre|u|s|a)\b[^>]*>/gi;
  const closeTagRegex = /<\/(b|i|code|pre|u|s|a)>/gi;

  const openTags: string[] = [];
  let match: RegExpExecArray | null;

  match = openTagRegex.exec(html);
  while (match) {
    openTags.push(match[1]!.toLowerCase());
    match = openTagRegex.exec(html);
  }

  match = closeTagRegex.exec(html);
  while (match) {
    const tag = match[1]!.toLowerCase();
    const idx = openTags.lastIndexOf(tag);
    if (idx !== -1) {
      openTags.splice(idx, 1);
    }
    match = closeTagRegex.exec(html);
  }

  // Append close tags in reverse order
  let result = html;
  for (let i = openTags.length - 1; i >= 0; i--) {
    result += `</${openTags[i]}>`;
  }

  return result;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function formatCorrelationFooter(event: BaseEvent): string {
  const parts: string[] = [];
  if (event.correlationId) {
    parts.push(
      `\nCorrelation: <code>${escapeHtml(event.correlationId)}</code>`,
    );
  }
  parts.push(`\nTime: <code>${formatTimestamp(event.timestamp)}</code>`);
  return parts.join('');
}

function paperModeTag(isPaper?: boolean, mixedMode?: boolean): string {
  const tags: string[] = [];
  if (isPaper) tags.push('[PAPER]');
  if (mixedMode) tags.push('[MIXED]');
  return tags.length > 0 ? ' ' + tags.join(' ') : '';
}

// ─── Per-Event Formatters ─────────────────────────────────────────────────────

export function formatOpportunityIdentified(event: {
  opportunity: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
}): string {
  const opp = event.opportunity;
  const str = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : 'N/A';
  const header = `${SEVERITY_EMOJI.info} <b>Opportunity Identified</b>`;
  const body = [
    `Edge: <code>${escapeHtml(str(opp['netEdge'] ?? opp['edge']))}</code>`,
    `Pair: <code>${escapeHtml(str(opp['pairId']))}</code>`,
    `Size: <code>${escapeHtml(str(opp['positionSizeUsd']))}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatOrderFilled(event: {
  orderId: string;
  platform: string;
  side: string;
  price: number;
  size: number;
  fillPrice: number;
  fillSize: number;
  positionId: string;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.info} <b>Order Filled</b>${tag}`;
  const slippage = new Decimal(event.fillPrice).minus(event.price).abs();
  const body = [
    `Order: <code>${escapeHtml(event.orderId)}</code>`,
    `Platform: <code>${escapeHtml(String(event.platform))}</code>`,
    `Side: <code>${escapeHtml(event.side)}</code>`,
    `Price: <code>${event.price.toFixed(4)}</code> → Fill: <code>${event.fillPrice.toFixed(4)}</code>`,
    `Size: <code>${event.size}</code> → Fill: <code>${event.fillSize}</code>`,
    `Slippage: <code>${slippage.toFixed(4).toString()}</code>`,
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatExecutionFailed(event: {
  reasonCode: number;
  reason: string;
  opportunityId: string;
  context: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.warning} <b>Execution Failed</b>${tag}`;
  const body = [
    `Error Code: <code>${event.reasonCode}</code>`,
    `Reason: ${escapeHtml(event.reason)}`,
    `Opportunity: <code>${escapeHtml(event.opportunityId)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatSingleLegExposure(event: {
  positionId: string;
  pairId: string;
  expectedEdge: number;
  filledLeg: {
    platform: string;
    orderId: string;
    side: string;
    price: number;
    size: number;
    fillPrice: number;
    fillSize: number;
  };
  failedLeg: {
    platform: string;
    reason: string;
    reasonCode: number;
    attemptedPrice: number;
    attemptedSize: number;
  };
  pnlScenarios: {
    closeNowEstimate: string;
    retryAtCurrentPrice: string;
    holdRiskAssessment: string;
  };
  recommendedActions: string[];
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 SINGLE LEG EXPOSURE</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Expected Edge: <code>${event.expectedEdge.toFixed(4)}</code>`,
    '',
    '<b>Filled Leg:</b>',
    `  Platform: <code>${escapeHtml(String(event.filledLeg.platform))}</code>`,
    `  Order: <code>${escapeHtml(event.filledLeg.orderId)}</code>`,
    `  Fill: <code>${event.filledLeg.fillPrice.toFixed(4)}</code> × <code>${event.filledLeg.fillSize}</code>`,
    '',
    '<b>Failed Leg:</b>',
    `  Platform: <code>${escapeHtml(String(event.failedLeg.platform))}</code>`,
    `  Reason: ${escapeHtml(event.failedLeg.reason)} (<code>${event.failedLeg.reasonCode}</code>)`,
    '',
    '<b>P&amp;L Scenarios:</b>',
    `  Close now: <code>${escapeHtml(event.pnlScenarios.closeNowEstimate)}</code>`,
    `  Retry: <code>${escapeHtml(event.pnlScenarios.retryAtCurrentPrice)}</code>`,
    `  Hold risk: <code>${escapeHtml(event.pnlScenarios.holdRiskAssessment)}</code>`,
    '',
    '<b>Recommended:</b>',
    ...event.recommendedActions.map((a) => `• ${escapeHtml(a)}`),
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatSingleLegResolved(event: {
  positionId: string;
  pairId: string;
  resolutionType: string;
  resolvedOrder: {
    orderId: string;
    platform: string;
    status: string;
    filledPrice: number;
    filledQuantity: number;
  };
  originalEdge: number;
  newEdge: number | null;
  realizedPnl: string | null;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.info} <b>Single Leg Resolved</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Resolution: <code>${escapeHtml(event.resolutionType)}</code>`,
    `Order: <code>${escapeHtml(event.resolvedOrder.orderId)}</code> on <code>${escapeHtml(String(event.resolvedOrder.platform))}</code>`,
    `Fill: <code>${event.resolvedOrder.filledPrice.toFixed(4)}</code> × <code>${event.resolvedOrder.filledQuantity}</code>`,
    `Original Edge: <code>${event.originalEdge.toFixed(4)}</code>`,
    event.newEdge !== null
      ? `New Edge: <code>${event.newEdge.toFixed(4)}</code>`
      : '',
    event.realizedPnl !== null
      ? `Realized P&L: <code>${escapeHtml(event.realizedPnl)}</code>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatExitTriggered(event: {
  positionId: string;
  pairId: string;
  exitType: string;
  initialEdge: string;
  finalEdge: string;
  realizedPnl: string;
  kalshiCloseOrderId: string;
  polymarketCloseOrderId: string;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const exitLabel =
    event.exitType === 'take_profit'
      ? 'Take Profit'
      : event.exitType === 'stop_loss'
        ? 'Stop Loss'
        : 'Time-Based';
  const header = `${SEVERITY_EMOJI.info} <b>Exit Triggered: ${escapeHtml(exitLabel)}</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Edge: <code>${escapeHtml(event.initialEdge)}</code> → <code>${escapeHtml(event.finalEdge)}</code>`,
    `Realized P&L: <code>${escapeHtml(event.realizedPnl)}</code>`,
    `Kalshi Close: <code>${escapeHtml(event.kalshiCloseOrderId)}</code>`,
    `Polymarket Close: <code>${escapeHtml(event.polymarketCloseOrderId)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatLimitApproached(event: {
  limitType: string;
  currentValue: number;
  threshold: number;
  percentUsed: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.warning} <b>Risk Limit Approaching</b>`;
  const body = [
    `Limit: <code>${escapeHtml(event.limitType)}</code>`,
    `Current: <code>${event.currentValue.toFixed(2)}</code>`,
    `Threshold: <code>${event.threshold.toFixed(2)}</code>`,
    `Utilization: <code>${event.percentUsed.toFixed(1)}%</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatLimitBreached(event: {
  limitType: string;
  currentValue: number;
  threshold: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 RISK LIMIT BREACHED</b>`;
  const body = [
    `Limit: <code>${escapeHtml(event.limitType)}</code>`,
    `Current: <code>${event.currentValue.toFixed(2)}</code>`,
    `Threshold: <code>${event.threshold.toFixed(2)}</code>`,
    `Breach: <code>${new Decimal(event.currentValue).minus(event.threshold).toFixed(2).toString()}</code> over limit`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatPlatformDegraded(event: {
  platformId: string;
  health: {
    status: string;
    latencyMs: number | null;
    metadata?: Record<string, unknown>;
  };
  previousStatus: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.warning} <b>Platform Degraded</b>`;
  const body = [
    `Platform: <code>${escapeHtml(String(event.platformId))}</code>`,
    `Previous: <code>${escapeHtml(event.previousStatus)}</code> → Current: <code>${escapeHtml(event.health.status)}</code>`,
    event.health.latencyMs !== null
      ? `Latency: <code>${event.health.latencyMs}ms</code>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatPlatformRecovered(event: {
  platformId: string;
  health: { status: string; latencyMs: number | null };
  previousStatus: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.info} <b>Platform Recovered</b>`;
  const body = [
    `Platform: <code>${escapeHtml(String(event.platformId))}</code>`,
    `Was: <code>${escapeHtml(event.previousStatus)}</code> → Now: <code>${escapeHtml(event.health.status)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatTradingHalted(event: {
  reason: string;
  details: unknown;
  haltTimestamp: Date;
  severity: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 TRADING HALTED</b>`;
  const body = [
    `Reason: ${escapeHtml(event.reason)}`,
    `Severity: <code>${escapeHtml(event.severity)}</code>`,
    `Halt Time: <code>${formatTimestamp(event.haltTimestamp)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatTradingResumed(event: {
  removedReason: string;
  remainingReasons: string[];
  resumeTimestamp: Date;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.info} <b>Trading Resumed</b>`;
  const remaining =
    event.remainingReasons.length > 0
      ? `Remaining halts: ${event.remainingReasons.map((r) => escapeHtml(r)).join(', ')}`
      : 'No remaining halt reasons';
  const body = [
    `Removed: ${escapeHtml(event.removedReason)}`,
    remaining,
    `Resume Time: <code>${formatTimestamp(event.resumeTimestamp)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatReconciliationDiscrepancy(event: {
  positionId: string;
  pairId: string;
  discrepancyType: string;
  localState: string;
  platformState: string;
  recommendedAction: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 Reconciliation Discrepancy</b>`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Type: <code>${escapeHtml(event.discrepancyType)}</code>`,
    `Local: <code>${escapeHtml(event.localState)}</code>`,
    `Platform: <code>${escapeHtml(event.platformState)}</code>`,
    `Action: ${escapeHtml(event.recommendedAction)}`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatSystemHealthCritical(event: {
  component: string;
  diagnosticInfo: string;
  recommendedActions: string[];
  severity: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 System Health Critical</b>`;
  const body = [
    `Component: <code>${escapeHtml(event.component)}</code>`,
    `Diagnostic: ${escapeHtml(event.diagnosticInfo)}`,
    '',
    '<b>Recommended Actions:</b>',
    ...event.recommendedActions.map((a) => `• ${escapeHtml(a)}`),
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatTestAlert(): string {
  const now = new Date();
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const header = `${SEVERITY_EMOJI.info} <b>Daily Test Alert</b>`;
  const body = [
    `Timestamp: <code>${formatTimestamp(now)}</code>`,
    `Uptime: <code>${hours}h ${minutes}m</code>`,
    'Alerting system healthy',
  ].join('\n');
  return `${header}\n\n${body}`;
}

// ─── Event Severity Mapping ───────────────────────────────────────────────────

const EVENT_SEVERITY_MAP: Record<string, AlertSeverity> = {
  'execution.single_leg.exposure': 'critical',
  'risk.limit.breached': 'critical',
  'system.trading.halted': 'critical',
  'system.health.critical': 'critical',
  'system.reconciliation.discrepancy': 'critical',
  'execution.order.failed': 'warning',
  'risk.limit.approached': 'warning',
  'platform.health.degraded': 'warning',
  'execution.exit.triggered': 'info',
  'execution.order.filled': 'info',
  'detection.opportunity.identified': 'info',
  'execution.single_leg.resolved': 'info',
  'platform.health.recovered': 'info',
  'system.trading.resumed': 'info',
};

export function getEventSeverity(eventName: string): AlertSeverity {
  return EVENT_SEVERITY_MAP[eventName] ?? 'info';
}
