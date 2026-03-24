import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EVENT_NAMES,
  TradingHaltedEvent,
  TradingResumedEvent,
} from '../../common/events';
import type { ModeRiskState, HaltReason } from './risk-state-manager.service';

/**
 * Shared halt/resume state operations used by both RiskStateManager
 * (automatic daily-loss halts) and TradingHaltService (explicit halts).
 * Centralizes state mutation + event emission to prevent logic divergence.
 */

export function applyHalt(
  state: ModeRiskState,
  reason: HaltReason,
  eventEmitter: EventEmitter2,
  isPaper: boolean,
): boolean {
  if (state.activeHaltReasons.has(reason)) return false;
  state.activeHaltReasons.add(reason);
  if (!isPaper) {
    eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_HALTED,
      new TradingHaltedEvent(
        reason,
        { activeReasons: [...state.activeHaltReasons] },
        new Date(),
        'critical',
      ),
    );
  }
  return true;
}

export function applyResume(
  state: ModeRiskState,
  reason: HaltReason,
  eventEmitter: EventEmitter2,
  isLive: boolean,
): boolean {
  if (!state.activeHaltReasons.has(reason)) return false;
  state.activeHaltReasons.delete(reason);
  if (isLive) {
    eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_RESUMED,
      new TradingResumedEvent(reason, [...state.activeHaltReasons], new Date()),
    );
  }
  return true;
}
