import { EventEmitter2 } from '@nestjs/event-emitter';
import { type MockInstance } from 'vitest';
import { EVENT_NAMES } from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { applyHalt, applyResume } from './halt.utils';
import type { ModeRiskState, HaltReason } from './risk-state-manager.service';

function createState(haltReasons: HaltReason[] = []): ModeRiskState {
  return {
    openPositionCount: 0,
    totalCapitalDeployed: new FinancialDecimal(0),
    dailyPnl: new FinancialDecimal(0),
    activeHaltReasons: new Set<HaltReason>(haltReasons),
    dailyLossApproachEmitted: false,
    lastResetTimestamp: null,
  };
}

describe('halt.utils', () => {
  let emitter: EventEmitter2;

  let emitSpy: MockInstance<any>;

  beforeEach(() => {
    emitter = new EventEmitter2();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    emitSpy = vi.spyOn(emitter, 'emit') as unknown as MockInstance;
  });

  describe('applyHalt', () => {
    it('should add reason and return true when not already present', () => {
      const state = createState();
      const result = applyHalt(state, 'daily_loss_limit', emitter, false);
      expect(result).toBe(true);
      expect(state.activeHaltReasons.has('daily_loss_limit')).toBe(true);
    });

    it('should return false and not duplicate when reason already present', () => {
      const state = createState(['daily_loss_limit']);
      const result = applyHalt(state, 'daily_loss_limit', emitter, false);
      expect(result).toBe(false);
      expect(state.activeHaltReasons.size).toBe(1);
    });

    it('should emit SYSTEM_TRADING_HALTED for live mode', () => {
      const state = createState();
      applyHalt(state, 'daily_loss_limit', emitter, false);
      expect(emitSpy).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_TRADING_HALTED,
        expect.objectContaining({ reason: 'daily_loss_limit' }),
      );
    });

    it('should NOT emit SYSTEM_TRADING_HALTED for paper mode', () => {
      const state = createState();
      applyHalt(state, 'daily_loss_limit', emitter, true);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(state.activeHaltReasons.has('daily_loss_limit')).toBe(true);
    });

    it('should not emit when reason already present', () => {
      const state = createState(['daily_loss_limit']);
      applyHalt(state, 'daily_loss_limit', emitter, false);
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe('applyResume', () => {
    it('should remove reason and return true when present', () => {
      const state = createState(['daily_loss_limit']);
      const result = applyResume(state, 'daily_loss_limit', emitter, true);
      expect(result).toBe(true);
      expect(state.activeHaltReasons.has('daily_loss_limit')).toBe(false);
    });

    it('should return false when reason not present', () => {
      const state = createState();
      const result = applyResume(state, 'daily_loss_limit', emitter, true);
      expect(result).toBe(false);
    });

    it('should emit SYSTEM_TRADING_RESUMED for live mode', () => {
      const state = createState(['daily_loss_limit']);
      applyResume(state, 'daily_loss_limit', emitter, true);
      expect(emitSpy).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_TRADING_RESUMED,
        expect.objectContaining({
          removedReason: 'daily_loss_limit',
          remainingReasons: [],
        }),
      );
    });

    it('should NOT emit SYSTEM_TRADING_RESUMED for paper mode', () => {
      const state = createState(['daily_loss_limit']);
      applyResume(state, 'daily_loss_limit', emitter, false);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(state.activeHaltReasons.has('daily_loss_limit')).toBe(false);
    });

    it('should include remaining reasons in event payload', () => {
      const state = createState([
        'daily_loss_limit',
        'reconciliation_discrepancy',
      ]);
      applyResume(state, 'daily_loss_limit', emitter, true);
      expect(emitSpy).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_TRADING_RESUMED,
        expect.objectContaining({
          remainingReasons: ['reconciliation_discrepancy'],
        }),
      );
    });
  });
});
