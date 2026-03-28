import { BaseEvent } from './base.event';
import type { DataQualityFlags } from '../types/historical-data.types';

export class BacktestDataIngestedEvent extends BaseEvent {
  public readonly source: string;
  public readonly platform: string;
  public readonly contractId: string;
  public readonly recordCount: number;
  public readonly dateRange: { start: Date; end: Date };

  constructor(payload: {
    source: string;
    platform: string;
    contractId: string;
    recordCount: number;
    dateRange: { start: Date; end: Date };
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.source = payload.source;
    this.platform = payload.platform;
    this.contractId = payload.contractId;
    this.recordCount = payload.recordCount;
    this.dateRange = payload.dateRange;
  }
}

export class BacktestDataQualityWarningEvent extends BaseEvent {
  public readonly source: string;
  public readonly platform: string;
  public readonly contractId: string;
  public readonly flags: DataQualityFlags;
  public readonly message: string;

  constructor(payload: {
    source: string;
    platform: string;
    contractId: string;
    flags: DataQualityFlags;
    message: string;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.source = payload.source;
    this.platform = payload.platform;
    this.contractId = payload.contractId;
    this.flags = payload.flags;
    this.message = payload.message;
  }
}

export class BacktestValidationCompletedEvent extends BaseEvent {
  public readonly reportId: number;
  public readonly confirmedCount: number;
  public readonly ourOnlyCount: number;
  public readonly externalOnlyCount: number;
  public readonly conflictCount: number;

  constructor(payload: {
    reportId: number;
    confirmedCount: number;
    ourOnlyCount: number;
    externalOnlyCount: number;
    conflictCount: number;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.reportId = payload.reportId;
    this.confirmedCount = payload.confirmedCount;
    this.ourOnlyCount = payload.ourOnlyCount;
    this.externalOnlyCount = payload.externalOnlyCount;
    this.conflictCount = payload.conflictCount;
  }
}

// ============================================================
// Story 10-9-3: Backtest Simulation Engine Events
// ============================================================

export class BacktestRunStartedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly config: Record<string, unknown>;

  constructor(payload: {
    runId: string;
    config: Record<string, unknown>;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.config = payload.config;
  }
}

export class BacktestRunCompletedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly metrics: Record<string, unknown>;

  constructor(payload: {
    runId: string;
    metrics: Record<string, unknown>;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.metrics = payload.metrics;
  }
}

export class BacktestRunFailedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly errorCode: number;
  public readonly message: string;

  constructor(payload: {
    runId: string;
    errorCode: number;
    message: string;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.errorCode = payload.errorCode;
    this.message = payload.message;
  }
}

export class BacktestRunCancelledEvent extends BaseEvent {
  public readonly runId: string;

  constructor(payload: { runId: string; correlationId?: string }) {
    super(payload.correlationId);
    this.runId = payload.runId;
  }
}

export class BacktestPositionOpenedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly positionId: string;
  public readonly pairId: string;
  public readonly entryEdge: string;
  public readonly positionSizeUsd: string;

  constructor(payload: {
    runId: string;
    positionId: string;
    pairId: string;
    entryEdge: string;
    positionSizeUsd: string;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.positionId = payload.positionId;
    this.pairId = payload.pairId;
    this.entryEdge = payload.entryEdge;
    this.positionSizeUsd = payload.positionSizeUsd;
  }
}

export class BacktestPositionClosedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly positionId: string;
  public readonly pairId: string;
  public readonly exitReason: string;
  public readonly realizedPnl: string;
  public readonly holdingHours: string;

  constructor(payload: {
    runId: string;
    positionId: string;
    pairId: string;
    exitReason: string;
    realizedPnl: string;
    holdingHours: string;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.positionId = payload.positionId;
    this.pairId = payload.pairId;
    this.exitReason = payload.exitReason;
    this.realizedPnl = payload.realizedPnl;
    this.holdingHours = payload.holdingHours;
  }
}

export class BacktestEngineStateChangedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly fromState: string;
  public readonly toState: string;

  constructor(payload: {
    runId: string;
    fromState: string;
    toState: string;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.fromState = payload.fromState;
    this.toState = payload.toState;
  }
}

// ============================================================
// Story 10-9-4: Calibration Report & Sensitivity Events
// ============================================================

export class BacktestReportGeneratedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly summary: Record<string, unknown>;

  constructor(payload: {
    runId: string;
    summary: Record<string, unknown>;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.summary = payload.summary;
  }
}

export class BacktestSensitivityCompletedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly sweepCount: number;
  public readonly recommendedParams: Record<string, unknown>;

  constructor(payload: {
    runId: string;
    sweepCount: number;
    recommendedParams: Record<string, unknown>;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.sweepCount = payload.sweepCount;
    this.recommendedParams = payload.recommendedParams;
  }
}

export class BacktestSensitivityProgressEvent extends BaseEvent {
  public readonly runId: string;
  public readonly completedSweeps: number;
  public readonly totalPlannedSweeps: number;

  constructor(payload: {
    runId: string;
    completedSweeps: number;
    totalPlannedSweeps: number;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.completedSweeps = payload.completedSweeps;
    this.totalPlannedSweeps = payload.totalPlannedSweeps;
  }
}

export class BacktestWalkForwardCompletedEvent extends BaseEvent {
  public readonly runId: string;
  public readonly overfitFlags: string[];
  public readonly trainPct: number;
  public readonly testPct: number;

  constructor(payload: {
    runId: string;
    overfitFlags: string[];
    trainPct: number;
    testPct: number;
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.runId = payload.runId;
    this.overfitFlags = payload.overfitFlags;
    this.trainPct = payload.trainPct;
    this.testPct = payload.testPct;
  }
}

// ============================================================
// Story 10-9-6: Incremental Ingestion Freshness Events
// ============================================================

export class IncrementalDataStaleEvent extends BaseEvent {
  public readonly source: string;
  public readonly lastSuccessfulAt: Date | null;
  public readonly thresholdMs: number;
  public readonly ageMs: number;
  public readonly severity: 'warning' | 'error';

  constructor(payload: {
    source: string;
    lastSuccessfulAt: Date | null;
    thresholdMs: number;
    ageMs: number;
    severity: 'warning' | 'error';
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.source = payload.source;
    this.lastSuccessfulAt = payload.lastSuccessfulAt;
    this.thresholdMs = payload.thresholdMs;
    this.ageMs = payload.ageMs;
    this.severity = payload.severity;
  }
}

export interface IncrementalSourceSummary {
  source: string;
  recordsFetched: number;
  contractsUpdated: number;
  status: string;
  lastSuccessfulAt: Date | null;
}

export class IncrementalDataFreshnessUpdatedEvent extends BaseEvent {
  public readonly sources: IncrementalSourceSummary[];

  constructor(payload: {
    sources: IncrementalSourceSummary[];
    correlationId?: string;
  }) {
    super(payload.correlationId);
    this.sources = payload.sources;
  }
}
