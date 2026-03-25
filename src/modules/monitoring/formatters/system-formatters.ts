import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  formatTimestamp,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

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
