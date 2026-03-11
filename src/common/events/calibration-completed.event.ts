import { BaseEvent } from './base.event';

export interface CalibrationBand {
  range: string;
  matchCount: number;
  divergedCount: number;
  /** Percentage (0 to 100), e.g. 8.3 = 8.3%. Already multiplied by 100. */
  divergenceRate: number;
}

export interface BoundaryAnalysisEntry {
  threshold: number;
  matchesAbove: number;
  divergedAbove: number;
  divergenceRateAbove: number;
  recommendation: string | null;
}

export interface CalibrationResult {
  timestamp: Date;
  totalResolvedMatches: number;
  tiers: {
    autoApprove: CalibrationBand;
    pendingReview: CalibrationBand;
    autoReject: CalibrationBand;
  };
  boundaryAnalysis: BoundaryAnalysisEntry[];
  currentAutoApproveThreshold: number;
  currentMinReviewThreshold: number;
  recommendations: string[];
  minimumDataMet: boolean;
}

export class CalibrationCompletedEvent extends BaseEvent {
  constructor(
    public readonly calibrationResult: CalibrationResult,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
