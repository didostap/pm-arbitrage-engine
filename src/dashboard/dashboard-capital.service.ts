import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { computeModeCapital } from './dashboard-capital.utils';
import { calculateLegCapital } from '../common/utils/capital';
import { EVENT_NAMES } from '../common/events/event-catalog';
import { BankrollUpdatedEvent } from '../common/events/config.events';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.module';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository';
import type { BankrollConfigDto } from './dto/bankroll-config.dto';
import { AuditLogService } from '../modules/monitoring/audit-log.service';

/**
 * Handles capital math, bankroll config, PnL computation, and time held.
 * Extracted from DashboardService (Story 10-8-4).
 *
 * Constructor deps: 5 (IRiskManager, EventEmitter2, EngineConfigRepository,
 * AuditLogService, Logger — Logger is class-level, not injected).
 * Actual injected deps: 4. Under limit.
 */
@Injectable()
export class DashboardCapitalService {
  private readonly logger = new Logger(DashboardCapitalService.name);

  constructor(
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly eventEmitter: EventEmitter2,
    private readonly engineConfigRepository: EngineConfigRepository,
    private readonly auditLogService: AuditLogService,
  ) {}

  getBankrollConfig(): Promise<BankrollConfigDto> {
    return this.riskManager.getBankrollConfig();
  }

  async updateBankroll(bankrollUsd: string): Promise<BankrollConfigDto> {
    const previousConfig = await this.riskManager.getBankrollConfig();
    await this.engineConfigRepository.upsertBankroll(bankrollUsd);
    await this.riskManager.reloadBankroll();
    const newConfig = await this.riskManager.getBankrollConfig();

    this.eventEmitter.emit(
      EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
      new BankrollUpdatedEvent(
        previousConfig.bankrollUsd,
        newConfig.bankrollUsd,
        'dashboard',
      ),
    );

    try {
      await this.auditLogService.append({
        eventType: EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
        module: 'dashboard',
        details: {
          previousValue: previousConfig.bankrollUsd,
          newValue: newConfig.bankrollUsd,
          updatedBy: 'dashboard',
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to create audit log for bankroll update',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    return newConfig;
  }

  computeModeCapital(
    bankrollStr: string,
    riskState?: {
      totalCapitalDeployed: { toString(): string };
      reservedCapital: { toString(): string };
    } | null,
  ): {
    bankroll: string | null;
    deployed: string | null;
    available: string | null;
    reserved: string | null;
  } {
    return computeModeCapital(bankrollStr, riskState);
  }

  computeCapitalBreakdown(
    position: {
      kalshiOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      polymarketOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      kalshiOrderId: string | null;
      polymarketOrderId: string | null;
      kalshiSide: string | null;
      polymarketSide: string | null;
      entryKalshiFeeRate: { toString(): string } | null;
      entryPolymarketFeeRate: { toString(): string } | null;
    },
    allOrders: Array<{
      orderId: string;
      platform: string;
      fillPrice: { toString(): string } | null;
      fillSize: { toString(): string } | null;
    }>,
  ) {
    if (
      !position.kalshiOrder?.fillPrice ||
      !position.kalshiOrder?.fillSize ||
      !position.polymarketOrder?.fillPrice ||
      !position.polymarketOrder?.fillSize
    ) {
      return {
        entryCapitalKalshi: null,
        entryCapitalPolymarket: null,
        feesKalshi: null,
        feesPolymarket: null,
        grossPnl: null,
        netPnl: null,
      };
    }

    const kalshiFillPrice = new Decimal(
      position.kalshiOrder.fillPrice.toString(),
    );
    const kalshiFillSize = new Decimal(
      position.kalshiOrder.fillSize.toString(),
    );
    const polyFillPrice = new Decimal(
      position.polymarketOrder.fillPrice.toString(),
    );
    const polyFillSize = new Decimal(
      position.polymarketOrder.fillSize.toString(),
    );

    const entryCapitalKalshi = calculateLegCapital(
      position.kalshiSide ?? 'buy',
      kalshiFillPrice,
      kalshiFillSize,
    );
    const entryCapitalPolymarket = calculateLegCapital(
      position.polymarketSide ?? 'buy',
      polyFillPrice,
      polyFillSize,
    );

    const kalshiFeeRate = position.entryKalshiFeeRate
      ? new Decimal(position.entryKalshiFeeRate.toString())
      : new Decimal(0);
    const polyFeeRate = position.entryPolymarketFeeRate
      ? new Decimal(position.entryPolymarketFeeRate.toString())
      : new Decimal(0);

    const entryOrderIds = new Set<string>();
    if (position.kalshiOrderId) entryOrderIds.add(position.kalshiOrderId);
    if (position.polymarketOrderId)
      entryOrderIds.add(position.polymarketOrderId);

    const exitOrders = allOrders.filter(
      (o) => !entryOrderIds.has(o.orderId) && o.fillPrice && o.fillSize,
    );

    let feesKalshi = new Decimal(0);
    let feesPolymarket = new Decimal(0);
    let grossPnl = new Decimal(0);

    for (const o of exitOrders) {
      const fp = new Decimal(o.fillPrice!.toString());
      const fs = new Decimal(o.fillSize!.toString());
      if (o.platform === 'KALSHI') {
        feesKalshi = feesKalshi.plus(fp.mul(fs).mul(kalshiFeeRate));
        const legPnl =
          position.kalshiSide === 'buy'
            ? fp.minus(kalshiFillPrice).mul(fs)
            : kalshiFillPrice.minus(fp).mul(fs);
        grossPnl = grossPnl.plus(legPnl);
      } else if (o.platform === 'POLYMARKET') {
        feesPolymarket = feesPolymarket.plus(fp.mul(fs).mul(polyFeeRate));
        const legPnl =
          position.polymarketSide === 'buy'
            ? fp.minus(polyFillPrice).mul(fs)
            : polyFillPrice.minus(fp).mul(fs);
        grossPnl = grossPnl.plus(legPnl);
      }
    }

    const totalFees = feesKalshi.plus(feesPolymarket);
    const netPnl = grossPnl.minus(totalFees);
    const hasExitOrders = exitOrders.length > 0;

    return {
      entryCapitalKalshi: entryCapitalKalshi.toFixed(8),
      entryCapitalPolymarket: entryCapitalPolymarket.toFixed(8),
      feesKalshi: feesKalshi.toFixed(8),
      feesPolymarket: feesPolymarket.toFixed(8),
      grossPnl: hasExitOrders ? grossPnl.toFixed(8) : null,
      netPnl: hasExitOrders ? netPnl.toFixed(8) : null,
    };
  }

  computeRealizedPnl(
    position: {
      kalshiOrderId: string | null;
      polymarketOrderId: string | null;
      kalshiSide: string | null;
      polymarketSide: string | null;
      kalshiOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      polymarketOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      entryKalshiFeeRate: { toString(): string } | null;
      entryPolymarketFeeRate: { toString(): string } | null;
    },
    allPairOrders: Array<{
      orderId: string;
      platform: string;
      fillPrice: { toString(): string } | null;
      fillSize: { toString(): string } | null;
    }>,
  ): string | null {
    if (
      !position.kalshiOrder?.fillPrice ||
      !position.kalshiOrder?.fillSize ||
      !position.polymarketOrder?.fillPrice ||
      !position.polymarketOrder?.fillSize
    ) {
      return null;
    }

    const entryOrderIds = new Set<string>();
    if (position.kalshiOrderId) entryOrderIds.add(position.kalshiOrderId);
    if (position.polymarketOrderId)
      entryOrderIds.add(position.polymarketOrderId);

    const exitOrders = allPairOrders.filter(
      (o) => !entryOrderIds.has(o.orderId) && o.fillPrice && o.fillSize,
    );

    if (exitOrders.length === 0) return null;

    const kalshiEntryPrice = new Decimal(
      position.kalshiOrder.fillPrice.toString(),
    );
    const polymarketEntryPrice = new Decimal(
      position.polymarketOrder.fillPrice.toString(),
    );

    let totalPnl = new Decimal(0);

    for (const exitOrder of exitOrders) {
      const exitFillPrice = new Decimal(exitOrder.fillPrice!.toString());
      const exitFillSize = new Decimal(exitOrder.fillSize!.toString());

      if (exitOrder.platform === 'KALSHI') {
        const legPnl =
          position.kalshiSide === 'buy'
            ? exitFillPrice.minus(kalshiEntryPrice).mul(exitFillSize)
            : kalshiEntryPrice.minus(exitFillPrice).mul(exitFillSize);
        totalPnl = totalPnl.plus(legPnl);

        const feeRate = position.entryKalshiFeeRate
          ? new Decimal(position.entryKalshiFeeRate.toString())
          : new Decimal(0);
        totalPnl = totalPnl.minus(exitFillPrice.mul(exitFillSize).mul(feeRate));
      } else if (exitOrder.platform === 'POLYMARKET') {
        const legPnl =
          position.polymarketSide === 'buy'
            ? exitFillPrice.minus(polymarketEntryPrice).mul(exitFillSize)
            : polymarketEntryPrice.minus(exitFillPrice).mul(exitFillSize);
        totalPnl = totalPnl.plus(legPnl);

        const feeRate = position.entryPolymarketFeeRate
          ? new Decimal(position.entryPolymarketFeeRate.toString())
          : new Decimal(0);
        totalPnl = totalPnl.minus(exitFillPrice.mul(exitFillSize).mul(feeRate));
      }
    }

    return totalPnl.toFixed(8);
  }

  computeTimeHeld(start: Date, end: Date): string {
    const diffMs = end.getTime() - start.getTime();
    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
  }
}
