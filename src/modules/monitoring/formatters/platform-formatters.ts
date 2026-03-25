import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

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
  let metaSection = '';
  if (event.health.metadata && Object.keys(event.health.metadata).length > 0) {
    let metaStr: string;
    try {
      metaStr = JSON.stringify(event.health.metadata);
    } catch {
      metaStr = '[unserializable]';
    }
    const truncated =
      metaStr.length > 200 ? metaStr.slice(0, 197) + '...' : metaStr;
    metaSection = `\n\nMetadata: <code>${escapeHtml(truncated)}</code>`;
  }
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${metaSection}${footer}`);
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

export function formatOrderbookStale(event: {
  platformId: string;
  lastUpdateTimestamp: Date | null;
  stalenessMs: number;
  thresholdMs: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.warning} <b>ORDERBOOK STALE</b>`;
  const body = [
    `Platform: <code>${escapeHtml(String(event.platformId))}</code>`,
    `Stale for: <b>${Math.round(event.stalenessMs / 1000)}s</b>`,
    `Last update: <code>${event.lastUpdateTimestamp?.toISOString() ?? 'never'}</code>`,
    `Threshold: ${event.thresholdMs / 1000}s`,
    '',
    '<b>Action:</b> Check platform API status, WebSocket connection, and connector logs.',
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatOrderbookRecovered(event: {
  platformId: string;
  recoveryTimestamp: Date;
  downtimeMs: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.info} <b>ORDERBOOK RECOVERED</b>`;
  const body = [
    `Platform: <code>${escapeHtml(String(event.platformId))}</code>`,
    `Downtime: <b>${Math.round(event.downtimeMs / 1000)}s</b>`,
    `Recovered at: <code>${event.recoveryTimestamp.toISOString()}</code>`,
    '',
    'Orderbook data flow restored. Detection resumed.',
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatDataDivergence(event: {
  platformId: string;
  contractId: unknown;
  priceDelta: string;
  stalenessDeltaMs: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.warning} <b>⚠️ Data Divergence</b>`;
  const body = [
    `Platform: <code>${escapeHtml(String(event.platformId))}</code>`,
    `Contract: <code>${escapeHtml(String(event.contractId))}</code>`,
    `Price Delta: <code>${escapeHtml(event.priceDelta)}</code>`,
    `Staleness: <code>${event.stalenessDeltaMs}ms</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
