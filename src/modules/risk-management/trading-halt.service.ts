import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RiskStateManager,
  type HaltReason,
} from './risk-state-manager.service';
import { applyHalt, applyResume } from './halt.utils';

/**
 * Manages trading halt/resume lifecycle for explicit (operator/system) halts.
 * Always operates on live mode state only — paper mode does not support trading halts.
 * Automatic daily-loss halts are triggered by RiskStateManager.updateDailyPnl
 * using the same shared halt utilities (halt.utils.ts).
 */
@Injectable()
export class TradingHaltService {
  private readonly logger = new Logger(TradingHaltService.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly riskStateManager: RiskStateManager,
  ) {}

  isTradingHalted(isPaper: boolean = false): boolean {
    return this.riskStateManager.getState(isPaper).activeHaltReasons.size > 0;
  }

  getActiveHaltReasons(isPaper: boolean = false): string[] {
    return [...this.riskStateManager.getState(isPaper).activeHaltReasons];
  }

  haltTrading(reason: string): void {
    const state = this.riskStateManager.getState(false);
    if (!applyHalt(state, reason as HaltReason, this.eventEmitter, false))
      return;
    this.logger.log({
      message: `Trading halted: ${reason}`,
      data: { reason, activeReasons: [...state.activeHaltReasons] },
    });
    void this.riskStateManager.persistState('live');
  }

  resumeTrading(reason: string): void {
    const state = this.riskStateManager.getState(false);
    if (!applyResume(state, reason as HaltReason, this.eventEmitter, true))
      return;
    this.logger.log({
      message: `Halt reason removed: ${reason}`,
      data: {
        removedReason: reason,
        remainingReasons: [...state.activeHaltReasons],
        tradingResumed: state.activeHaltReasons.size === 0,
      },
    });
    void this.riskStateManager.persistState('live');
  }
}
