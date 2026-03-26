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
