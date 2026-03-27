import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { BacktestExitReason } from '@prisma/client';
import type {
  ExitEvaluation,
  SimulatedPosition,
} from '../types/simulation.types';

export interface ExitEvaluationParams {
  position: SimulatedPosition;
  currentNetEdge: Decimal;
  currentTimestamp: Date;
  exitEdgeEvaporationPct: Decimal;
  exitTimeLimitHours: number;
  exitProfitCapturePct: Decimal;
  resolutionTimestamp: Date | null;
  resolutionPrice: Decimal | null;
  hasDepth: boolean;
}

// Priority: 1 = highest (resolution) → 5 = lowest (time decay)
const EXIT_PRIORITY: Record<BacktestExitReason, number> = {
  RESOLUTION_FORCE_CLOSE: 1,
  INSUFFICIENT_DEPTH: 2,
  PROFIT_CAPTURE: 3,
  EDGE_EVAPORATION: 4,
  TIME_DECAY: 5,
  SIMULATION_END: 6,
};

@Injectable()
export class ExitEvaluatorService {
  evaluateExits(params: ExitEvaluationParams): ExitEvaluation | null {
    const triggered: ExitEvaluation[] = [];

    // 1. Resolution force-close (highest priority)
    if (this.isResolutionTriggered(params)) {
      triggered.push({
        triggered: true,
        reason: 'RESOLUTION_FORCE_CLOSE',
        priority: EXIT_PRIORITY.RESOLUTION_FORCE_CLOSE,
        currentEdge: params.currentNetEdge,
      });
    }

    // 2. Insufficient depth
    if (!params.hasDepth) {
      triggered.push({
        triggered: true,
        reason: 'INSUFFICIENT_DEPTH',
        priority: EXIT_PRIORITY.INSUFFICIENT_DEPTH,
        currentEdge: params.currentNetEdge,
      });
    }

    // 3. Profit capture
    if (this.isProfitCaptureTriggered(params)) {
      triggered.push({
        triggered: true,
        reason: 'PROFIT_CAPTURE',
        priority: EXIT_PRIORITY.PROFIT_CAPTURE,
        currentEdge: params.currentNetEdge,
      });
    }

    // 4. Edge evaporation
    if (this.isEdgeEvaporationTriggered(params)) {
      triggered.push({
        triggered: true,
        reason: 'EDGE_EVAPORATION',
        priority: EXIT_PRIORITY.EDGE_EVAPORATION,
        currentEdge: params.currentNetEdge,
      });
    }

    // 5. Time decay
    if (this.isTimeDecayTriggered(params)) {
      triggered.push({
        triggered: true,
        reason: 'TIME_DECAY',
        priority: EXIT_PRIORITY.TIME_DECAY,
        currentEdge: params.currentNetEdge,
      });
    }

    if (triggered.length === 0) return null;

    // Return highest priority (lowest number)
    triggered.sort((a, b) => a.priority - b.priority);
    return triggered[0] ?? null;
  }

  private isResolutionTriggered(params: ExitEvaluationParams): boolean {
    if (!params.resolutionTimestamp || !params.resolutionPrice) return false;
    return params.currentTimestamp >= params.resolutionTimestamp;
  }

  private isProfitCaptureTriggered(params: ExitEvaluationParams): boolean {
    const entryEdge = params.position.entryEdge;
    if (entryEdge.lte(0)) return false;
    // Profit captured = how much edge has converged toward zero
    // capturedRatio = (entryEdge - currentEdge) / entryEdge
    // Trigger when capturedRatio >= exitProfitCapturePct (e.g., 80% captured)
    const capturedRatio = entryEdge.minus(params.currentNetEdge).div(entryEdge);
    return capturedRatio.gte(params.exitProfitCapturePct);
  }

  private isEdgeEvaporationTriggered(params: ExitEvaluationParams): boolean {
    return params.currentNetEdge.lt(params.exitEdgeEvaporationPct);
  }

  private isTimeDecayTriggered(params: ExitEvaluationParams): boolean {
    const holdingMs =
      params.currentTimestamp.getTime() -
      params.position.entryTimestamp.getTime();
    const holdingHours = holdingMs / (1000 * 60 * 60);
    return holdingHours > params.exitTimeLimitHours;
  }
}
