import Decimal from 'decimal.js';
import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

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
    `Breach: <code>${escapeHtml(new Decimal(event.currentValue).minus(event.threshold).toFixed(2).toString())}</code> over limit`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatClusterLimitBreached(event: {
  clusterName: string;
  clusterId: string;
  currentExposurePct: number;
  hardLimitPct: number;
  triageRecommendations: {
    positionId: string;
    pairId: string;
    expectedEdge: string;
    capitalDeployed: string;
    suggestedAction: string;
    reason: string;
  }[];
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 CLUSTER LIMIT BREACHED</b>`;
  const body = [
    `Cluster: <code>${escapeHtml(event.clusterName)}</code>`,
    `Exposure: <code>${(event.currentExposurePct * 100).toFixed(1)}%</code>`,
    `Hard Limit: <code>${(event.hardLimitPct * 100).toFixed(0)}%</code>`,
  ].join('\n');

  const top3 = event.triageRecommendations.slice(0, 3);
  const triage =
    top3.length > 0
      ? '\n\n<b>Triage (close to free budget):</b>\n' +
        top3
          .map(
            (r, i) =>
              `${i + 1}. Edge: <code>${escapeHtml(r.expectedEdge)}</code> | Capital: <code>$${escapeHtml(r.capitalDeployed)}</code>`,
          )
          .join('\n')
      : '';

  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${triage}${footer}`);
}

export function formatAggregateClusterLimitBreached(event: {
  aggregateExposurePct: number;
  aggregateLimitPct: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 AGGREGATE CLUSTER LIMIT BREACHED</b>`;
  const body = [
    `Aggregate Exposure: <code>${(event.aggregateExposurePct * 100).toFixed(1)}%</code>`,
    `Limit: <code>${(event.aggregateLimitPct * 100).toFixed(0)}%</code>`,
    'No new positions allowed until aggregate drops below limit.',
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatBankrollUpdated(event: {
  previousValue: string;
  newValue: string;
  updatedBy: string;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.warning} <b>⚠️ Bankroll Updated</b>`;
  const prev = escapeHtml(event.previousValue);
  const next = escapeHtml(event.newValue);
  const body = [
    `Previous: <code>$${prev}</code>`,
    `New: <code>$${next}</code>`,
    `Updated by: <code>${escapeHtml(event.updatedBy)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
