import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { PositionRepository } from '../../persistence/repositories/position.repository';

const MONTHLY_THRESHOLD = 5;
const WEEKLY_CONSECUTIVE_THRESHOLD = 3;

@Injectable()
export class ExposureTrackerService implements OnModuleInit {
  private readonly logger = new Logger(ExposureTrackerService.name);

  /** Map<YYYY-MM, count> */
  readonly monthlyExposures = new Map<string, number>();

  /** Map<YYYY-Wnn, count> */
  readonly weeklyExposures = new Map<string, number>();

  /** Number of consecutive weeks with >1 single-leg event */
  consecutiveBreachedWeeks = 0;

  /** Last evaluated ISO week key */
  lastEvaluatedWeek: string | null = null;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly positionRepository: PositionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rebuildFromDb();
  }

  @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE)
  onSingleLegExposure(_event: SingleLegExposureEvent): void {
    const now = new Date();
    const monthKey = this.getMonthKey(now);
    const weekKey = this.getIsoWeekKey(now);

    // Increment monthly counter
    const monthCount = (this.monthlyExposures.get(monthKey) ?? 0) + 1;
    this.monthlyExposures.set(monthKey, monthCount);

    // Increment weekly counter
    const weekCount = (this.weeklyExposures.get(weekKey) ?? 0) + 1;
    this.weeklyExposures.set(weekKey, weekCount);

    // Check monthly threshold (AC 3)
    if (monthCount > MONTHLY_THRESHOLD) {
      this.eventEmitter.emit(EVENT_NAMES.LIMIT_APPROACHED, {
        type: 'monthly_exposure',
        message: `Single-leg exposure count (${monthCount}) exceeds monthly threshold (${MONTHLY_THRESHOLD}). Systematic investigation recommended.`,
        count: monthCount,
        threshold: MONTHLY_THRESHOLD,
        monthKey,
      });

      this.logger.warn({
        message: `Monthly single-leg exposure threshold exceeded`,
        module: 'execution',
        data: { monthKey, count: monthCount, threshold: MONTHLY_THRESHOLD },
      });
    }

    // Evaluate weekly consecutive threshold (AC 4)
    this.evaluateWeeklyConsecutive(weekKey, weekCount);
  }

  private evaluateWeeklyConsecutive(
    currentWeekKey: string,
    currentWeekCount: number,
  ): void {
    // On first event of a new week, evaluate if the previous week was breached
    if (
      this.lastEvaluatedWeek !== null &&
      this.lastEvaluatedWeek !== currentWeekKey
    ) {
      const prevCount = this.weeklyExposures.get(this.lastEvaluatedWeek) ?? 0;
      if (prevCount > 1) {
        this.consecutiveBreachedWeeks++;
      } else {
        this.consecutiveBreachedWeeks = 0;
      }
    }

    this.lastEvaluatedWeek = currentWeekKey;

    // Check if current week is now breached and we have enough consecutive
    if (
      currentWeekCount > 1 &&
      this.consecutiveBreachedWeeks >= WEEKLY_CONSECUTIVE_THRESHOLD - 1
    ) {
      this.eventEmitter.emit(EVENT_NAMES.LIMIT_BREACHED, {
        type: 'weekly_consecutive_exposure',
        message: `Sustained weekly single-leg exposure (${currentWeekCount}/week for ${this.consecutiveBreachedWeeks + 1} consecutive weeks). Systematic root cause investigation required.`,
        consecutiveWeeks: this.consecutiveBreachedWeeks + 1,
        currentWeekCount,
        weekKey: currentWeekKey,
      });

      this.logger.error({
        message: 'Sustained weekly single-leg exposure threshold exceeded',
        module: 'execution',
        data: {
          consecutiveWeeks: this.consecutiveBreachedWeeks + 1,
          currentWeekCount,
          weekKey: currentWeekKey,
        },
      });
    }
  }

  private async rebuildFromDb(): Promise<void> {
    try {
      const exposedPositions =
        await this.positionRepository.findByStatus('SINGLE_LEG_EXPOSED');

      const now = new Date();
      const currentMonth = this.getMonthKey(now);
      const currentWeek = this.getIsoWeekKey(now);

      // Collect weekly counts for consecutive-week rebuild
      const weeklyCounts = new Map<string, number>();

      for (const position of exposedPositions) {
        const createdAt = new Date(position.createdAt);
        const posMonthKey = this.getMonthKey(createdAt);
        const posWeekKey = this.getIsoWeekKey(createdAt);

        // Rebuild current month counter
        if (posMonthKey === currentMonth) {
          this.monthlyExposures.set(
            posMonthKey,
            (this.monthlyExposures.get(posMonthKey) ?? 0) + 1,
          );
        }
        // Rebuild current week counter
        if (posWeekKey === currentWeek) {
          this.weeklyExposures.set(
            posWeekKey,
            (this.weeklyExposures.get(posWeekKey) ?? 0) + 1,
          );
        }
        // Track all weekly counts for consecutive-week calculation
        weeklyCounts.set(posWeekKey, (weeklyCounts.get(posWeekKey) ?? 0) + 1);
      }

      // Rebuild consecutiveBreachedWeeks by walking backwards from current week
      this.consecutiveBreachedWeeks = 0;
      const checkDate = new Date(now);
      // Start from previous week (current week is evaluated live on event arrival)
      checkDate.setUTCDate(checkDate.getUTCDate() - 7);
      while (true) {
        const weekKey = this.getIsoWeekKey(checkDate);
        const count = weeklyCounts.get(weekKey) ?? 0;
        if (count > 1) {
          this.consecutiveBreachedWeeks++;
          checkDate.setUTCDate(checkDate.getUTCDate() - 7);
        } else {
          break;
        }
      }

      if (this.consecutiveBreachedWeeks > 0) {
        this.lastEvaluatedWeek = currentWeek;
      }

      this.logger.log({
        message: 'Exposure counters rebuilt from database',
        module: 'execution',
        data: {
          monthlyCount: this.monthlyExposures.get(currentMonth) ?? 0,
          weeklyCount: this.weeklyExposures.get(currentWeek) ?? 0,
          consecutiveBreachedWeeks: this.consecutiveBreachedWeeks,
          totalPositions: exposedPositions.length,
        },
      });
    } catch (err) {
      this.logger.error({
        message: 'Failed to rebuild exposure counters from database',
        module: 'execution',
        data: { error: (err as Error).message },
      });
    }
  }

  private getMonthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private getIsoWeekKey(date: Date): string {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
  }
}
