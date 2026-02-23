import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PositionStatus } from '@prisma/client';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants';
import type { IPlatformConnector } from '../common/interfaces/platform-connector.interface';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PrismaService } from '../common/prisma.service';
import {
  EVENT_NAMES,
  ReconciliationCompleteEvent,
  ReconciliationDiscrepancyEvent,
  OrderFilledEvent,
} from '../common/events';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { PlatformId } from '../common/types/platform.type';
import type {
  ReconciliationContext,
  ReconciliationResult,
  ReconciliationDiscrepancy,
} from '../common/types/reconciliation.types';

const API_CALL_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 60_000;

@Injectable()
export class StartupReconciliationService {
  private readonly logger = new Logger(StartupReconciliationService.name);
  private lastRunResult: ReconciliationResult | null = null;
  lastRunAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
  ) {}

  getLastRunResult(): ReconciliationResult | null {
    return this.lastRunResult;
  }

  async reconcile(): Promise<ReconciliationResult> {
    const startedAt = Date.now();
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const platformsUnavailable: string[] = [];
    let positionsChecked = 0;
    let ordersVerified = 0;
    let pendingOrdersResolved = 0;
    let timedOut = false;

    const checkTimeout = () => {
      if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
        timedOut = true;
        return true;
      }
      return false;
    };

    // Phase 1: Check connector health
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();

    const kalshiAvailable = kalshiHealth.status !== 'disconnected';
    const polymarketAvailable = polymarketHealth.status !== 'disconnected';

    if (!kalshiAvailable) platformsUnavailable.push(PlatformId.KALSHI);
    if (!polymarketAvailable) platformsUnavailable.push(PlatformId.POLYMARKET);

    // Phase 2: Pending order reconciliation
    if (!checkTimeout()) {
      const pendingResult = await this.reconcilePendingOrders(
        kalshiAvailable,
        polymarketAvailable,
        checkTimeout,
      );
      pendingOrdersResolved = pendingResult.resolved;
      ordersVerified += pendingResult.checked;
      discrepancies.push(...pendingResult.discrepancies);
    }

    // Phase 3: Active position order-level verification
    if (!checkTimeout()) {
      const positionResult = await this.reconcileActivePositions(
        kalshiAvailable,
        polymarketAvailable,
        checkTimeout,
      );
      positionsChecked = positionResult.checked;
      ordersVerified += positionResult.ordersVerified;
      discrepancies.push(...positionResult.discrepancies);
    }

    // Handle timeout — flag unchecked positions
    if (timedOut) {
      this.logger.warn({
        message: 'Reconciliation timed out — flagging unchecked positions',
        timestamp: new Date().toISOString(),
        module: StartupReconciliationService.name,
        data: { positionsChecked, ordersVerified, pendingOrdersResolved },
      });
    }

    const durationMs = Date.now() - startedAt;

    // Phase 4: Discrepancy handling OR risk budget recalculation
    if (discrepancies.length > 0) {
      await this.handleDiscrepancies(discrepancies);
    }

    // Always recalculate risk budget from current DB state
    await this.recalculateRiskBudget();

    const result: ReconciliationResult = {
      positionsChecked,
      ordersVerified,
      pendingOrdersResolved,
      discrepanciesFound: discrepancies.length,
      durationMs,
      platformsUnavailable,
      discrepancies,
    };

    this.lastRunResult = result;
    this.lastRunAt = new Date();

    // Emit completion event
    this.eventEmitter.emit(
      EVENT_NAMES.RECONCILIATION_COMPLETE,
      new ReconciliationCompleteEvent(
        positionsChecked,
        ordersVerified,
        pendingOrdersResolved,
        discrepancies.length,
        durationMs,
        timedOut
          ? `Reconciliation timed out after ${durationMs}ms`
          : discrepancies.length > 0
            ? `Found ${discrepancies.length} discrepancies`
            : 'Clean reconciliation',
      ),
    );

    // Log results
    if (discrepancies.length > 0) {
      this.logger.error({
        message: 'Reconciliation found discrepancies',
        timestamp: new Date().toISOString(),
        module: StartupReconciliationService.name,
        data: {
          positionsChecked,
          ordersVerified,
          pendingOrdersResolved,
          discrepancies,
          durationMs,
          platformStatus: {
            kalshi: kalshiHealth.status,
            polymarket: polymarketHealth.status,
          },
        },
      });
    } else {
      this.logger.log({
        message: 'Reconciliation complete, no discrepancies',
        timestamp: new Date().toISOString(),
        module: StartupReconciliationService.name,
        data: {
          positionsChecked,
          ordersVerified,
          pendingOrdersResolved,
          durationMs,
          platformStatus: {
            kalshi: kalshiHealth.status,
            polymarket: polymarketHealth.status,
          },
        },
      });
    }

    return result;
  }

  async reconcilePendingOrders(
    kalshiAvailable: boolean,
    polymarketAvailable: boolean,
    checkTimeout: () => boolean,
  ): Promise<{
    resolved: number;
    checked: number;
    discrepancies: ReconciliationDiscrepancy[];
  }> {
    const pendingOrders = await this.orderRepository.findPendingOrders();
    let resolved = 0;
    let checked = 0;
    const discrepancies: ReconciliationDiscrepancy[] = [];

    for (const order of pendingOrders) {
      if (checkTimeout()) break;

      const isKalshi = order.platform === 'KALSHI';
      const connector = isKalshi
        ? this.kalshiConnector
        : this.polymarketConnector;
      const available = isKalshi ? kalshiAvailable : polymarketAvailable;

      if (!available) {
        continue;
      }

      checked++;

      try {
        const platformStatus = await this.callWithTimeout(
          () => connector.getOrder(order.orderId),
          API_CALL_TIMEOUT_MS,
        );

        if (platformStatus.status === 'filled') {
          // Update the order to FILLED with fill data
          await this.orderRepository.updateOrderStatus(
            order.orderId,
            'FILLED',
            platformStatus.fillPrice,
            platformStatus.fillSize,
          );

          // Check if this completes a single-leg position
          await this.resolvePendingFilledOrder(order, platformStatus);
          resolved++;
        } else if (
          platformStatus.status === 'cancelled' ||
          platformStatus.status === 'rejected'
        ) {
          const statusMap: Record<string, 'CANCELLED' | 'REJECTED'> = {
            cancelled: 'CANCELLED',
            rejected: 'REJECTED',
          };
          await this.orderRepository.updateOrderStatus(
            order.orderId,
            statusMap[platformStatus.status],
          );
          resolved++;

          this.logger.log({
            message: `Pending order ${platformStatus.status} on platform`,
            timestamp: new Date().toISOString(),
            module: StartupReconciliationService.name,
            data: { orderId: order.orderId, status: platformStatus.status },
          });
        } else if (platformStatus.status === 'not_found') {
          // Look up the actual position for this order's pair
          const relatedPositions =
            await this.positionRepository.findByStatus('SINGLE_LEG_EXPOSED');
          const matchingPosition = relatedPositions.find(
            (p) => p.pairId === order.pairId,
          );

          discrepancies.push({
            positionId: matchingPosition?.positionId ?? order.pairId,
            pairId: order.pairId,
            discrepancyType: 'order_not_found',
            localState: 'PENDING',
            platformState: 'not_found',
            recommendedAction:
              'Investigate missing order — may have been cancelled externally',
          });
        }
        // If still pending, leave as-is
      } catch (error) {
        this.logger.warn({
          message: 'Failed to check pending order on platform',
          timestamp: new Date().toISOString(),
          module: StartupReconciliationService.name,
          data: {
            orderId: order.orderId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }

    return { resolved, checked, discrepancies };
  }

  async reconcileActivePositions(
    kalshiAvailable: boolean,
    polymarketAvailable: boolean,
    checkTimeout: () => boolean,
  ): Promise<{
    checked: number;
    ordersVerified: number;
    discrepancies: ReconciliationDiscrepancy[];
  }> {
    const activePositions = await this.positionRepository.findActivePositions();
    let checked = 0;
    let ordersVerified = 0;
    const discrepancies: ReconciliationDiscrepancy[] = [];

    for (const position of activePositions) {
      if (checkTimeout()) break;

      // Skip RECONCILIATION_REQUIRED — already flagged
      if (position.status === 'RECONCILIATION_REQUIRED') {
        checked++;
        continue;
      }

      checked++;
      const posDiscrepancies: ReconciliationDiscrepancy[] = [];

      // Check Kalshi order
      if (position.kalshiOrder) {
        if (!kalshiAvailable) {
          posDiscrepancies.push({
            positionId: position.positionId,
            pairId: position.pairId,
            discrepancyType: 'platform_unavailable',
            localState: position.kalshiOrder.status,
            platformState: 'platform_unavailable',
            recommendedAction: 'Retry reconciliation when Kalshi is available',
          });
        } else {
          try {
            const result = await this.callWithTimeout(
              () =>
                this.kalshiConnector.getOrder(position.kalshiOrder!.orderId),
              API_CALL_TIMEOUT_MS,
            );
            ordersVerified++;

            const disc = this.checkOrderDiscrepancy(
              position.positionId,
              position.pairId,
              position.kalshiOrder.status,
              result.status,
              PlatformId.KALSHI,
              result,
            );
            if (disc) posDiscrepancies.push(disc);
          } catch (error) {
            this.logger.warn({
              message: 'Failed to verify Kalshi order',
              timestamp: new Date().toISOString(),
              module: StartupReconciliationService.name,
              data: {
                positionId: position.positionId,
                orderId: position.kalshiOrder.orderId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
            });
          }
        }
      }

      // Check Polymarket order
      if (position.polymarketOrder) {
        if (!polymarketAvailable) {
          posDiscrepancies.push({
            positionId: position.positionId,
            pairId: position.pairId,
            discrepancyType: 'platform_unavailable',
            localState: position.polymarketOrder.status,
            platformState: 'platform_unavailable',
            recommendedAction:
              'Retry reconciliation when Polymarket is available',
          });
        } else {
          try {
            const result = await this.callWithTimeout(
              () =>
                this.polymarketConnector.getOrder(
                  position.polymarketOrder!.orderId,
                ),
              API_CALL_TIMEOUT_MS,
            );
            ordersVerified++;

            const disc = this.checkOrderDiscrepancy(
              position.positionId,
              position.pairId,
              position.polymarketOrder.status,
              result.status,
              PlatformId.POLYMARKET,
              result,
            );
            if (disc) posDiscrepancies.push(disc);
          } catch (error) {
            this.logger.warn({
              message: 'Failed to verify Polymarket order',
              timestamp: new Date().toISOString(),
              module: StartupReconciliationService.name,
              data: {
                positionId: position.positionId,
                orderId: position.polymarketOrder.orderId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
            });
          }
        }
      }

      if (posDiscrepancies.length > 0) {
        discrepancies.push(...posDiscrepancies);
      }
    }

    return { checked, ordersVerified, discrepancies };
  }

  async resolveDiscrepancy(
    positionId: string,
    action: 'acknowledge' | 'force_close',
    rationale: string,
  ): Promise<{
    success: boolean;
    positionId: string;
    newStatus: PositionStatus;
    remainingDiscrepancies: number;
  }> {
    const position = await this.positionRepository.findById(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    if (position.status !== 'RECONCILIATION_REQUIRED') {
      throw new Error(
        `Position ${positionId} is not in RECONCILIATION_REQUIRED state (current: ${position.status})`,
      );
    }

    let newStatus: PositionStatus;

    if (action === 'acknowledge') {
      const context =
        position.reconciliationContext as ReconciliationContext | null;
      if (!context) {
        throw new Error(
          `No reconciliation context found for position ${positionId}`,
        );
      }
      newStatus = context.recommendedStatus;
      await this.prisma.openPosition.update({
        where: { positionId },
        data: {
          status: newStatus,
          reconciliationContext: undefined,
        },
      });
    } else {
      // force_close
      newStatus = 'CLOSED';
      await this.prisma.openPosition.update({
        where: { positionId },
        data: {
          status: 'CLOSED',
          reconciliationContext: undefined,
        },
      });
      // Return capital with zero P&L
      await this.riskManager.closePosition(new Decimal(0), new Decimal(0));
    }

    this.logger.log({
      message: `Discrepancy resolved for position ${positionId}`,
      timestamp: new Date().toISOString(),
      module: StartupReconciliationService.name,
      data: { positionId, action, rationale, newStatus },
    });

    // Check if any RECONCILIATION_REQUIRED positions remain
    const remaining = await this.positionRepository.findByStatus(
      'RECONCILIATION_REQUIRED',
    );
    const remainingDiscrepancies = remaining.length;

    if (remainingDiscrepancies === 0) {
      this.riskManager.resumeTrading('reconciliation_discrepancy');
    }

    // Recalculate risk budget after resolution
    await this.recalculateRiskBudget();

    return { success: true, positionId, newStatus, remainingDiscrepancies };
  }

  private async resolvePendingFilledOrder(
    order: { orderId: string; platform: string; pairId: string; side: string },
    platformStatus: {
      fillPrice?: number;
      fillSize?: number;
      status: string;
    },
  ): Promise<void> {
    // Find positions for this pair that are SINGLE_LEG_EXPOSED
    const positions =
      await this.positionRepository.findByStatus('SINGLE_LEG_EXPOSED');
    const matchingPosition = positions.find((p) => p.pairId === order.pairId);

    if (!matchingPosition) return;

    // Determine which order FK is null (the missing leg)
    const isKalshi = order.platform === 'KALSHI';
    const missingKalshi = !matchingPosition.kalshiOrderId;
    const missingPolymarket = !matchingPosition.polymarketOrderId;

    if (isKalshi && missingKalshi) {
      await this.positionRepository.updateWithOrder(
        matchingPosition.positionId,
        {
          kalshiOrder: { connect: { orderId: order.orderId } },
          status: 'OPEN',
        },
      );
    } else if (!isKalshi && missingPolymarket) {
      await this.positionRepository.updateWithOrder(
        matchingPosition.positionId,
        {
          polymarketOrder: { connect: { orderId: order.orderId } },
          status: 'OPEN',
        },
      );
    }

    // Emit OrderFilledEvent
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      // Reconciliation runs at startup before mode context is relevant.
      // Hardcoding false/false for live defaults.
      new OrderFilledEvent(
        order.orderId,
        isKalshi ? PlatformId.KALSHI : PlatformId.POLYMARKET,
        order.side,
        0, // original price not available here
        0, // original size not available here
        platformStatus.fillPrice ?? 0,
        platformStatus.fillSize ?? 0,
        matchingPosition.positionId,
        undefined,
        false,
        false,
      ),
    );

    this.logger.log({
      message: 'Pending order filled after timeout — position now OPEN',
      timestamp: new Date().toISOString(),
      module: StartupReconciliationService.name,
      data: {
        orderId: order.orderId,
        positionId: matchingPosition.positionId,
        fillPrice: platformStatus.fillPrice,
        fillSize: platformStatus.fillSize,
      },
    });
  }

  private checkOrderDiscrepancy(
    positionId: string,
    pairId: string,
    localStatus: string,
    platformStatus: string,
    _platform: PlatformId,
    rawResult: unknown,
  ): ReconciliationDiscrepancy | null {
    // Map platform status back to local status for comparison
    const platformToLocalStatus: Record<string, string> = {
      filled: 'FILLED',
      pending: 'PENDING',
      cancelled: 'CANCELLED',
      rejected: 'REJECTED',
      partial: 'PARTIAL',
    };

    if (platformStatus === 'not_found') {
      return {
        positionId,
        pairId,
        discrepancyType: 'order_not_found',
        localState: localStatus,
        platformState: 'not_found',
        recommendedAction:
          'Order not found on platform — may have been purged or ID mismatch',
      };
    }

    const mappedPlatformStatus = platformToLocalStatus[platformStatus];
    if (mappedPlatformStatus && mappedPlatformStatus !== localStatus) {
      // A pending→filled transition detected via position verification
      if (localStatus === 'PENDING' && platformStatus === 'filled') {
        return {
          positionId,
          pairId,
          discrepancyType: 'pending_filled',
          localState: localStatus,
          platformState: `${platformStatus} (raw: ${JSON.stringify(rawResult)})`,
          recommendedAction:
            'Order filled on platform but local state is PENDING — update order and verify position',
        };
      }

      return {
        positionId,
        pairId,
        discrepancyType: 'order_status_mismatch',
        localState: localStatus,
        platformState: `${platformStatus} (raw: ${JSON.stringify(rawResult)})`,
        recommendedAction: `Local=${localStatus}, Platform=${platformStatus} — investigate and resolve`,
      };
    }

    return null;
  }

  private async handleDiscrepancies(
    discrepancies: ReconciliationDiscrepancy[],
  ): Promise<void> {
    for (const disc of discrepancies) {
      // Flag position as RECONCILIATION_REQUIRED
      const context: ReconciliationContext = {
        recommendedStatus: this.getRecommendedStatus(disc),
        discrepancyType: disc.discrepancyType,
        platformState: { raw: disc.platformState },
        detectedAt: new Date().toISOString(),
      };

      try {
        await this.prisma.openPosition.update({
          where: { positionId: disc.positionId },
          data: {
            status: 'RECONCILIATION_REQUIRED',
            reconciliationContext: JSON.stringify(context),
          },
        });
      } catch {
        // Position might not exist (e.g., discrepancy from pending order with pairId)
        this.logger.warn({
          message: `Failed to flag position as RECONCILIATION_REQUIRED`,
          timestamp: new Date().toISOString(),
          module: StartupReconciliationService.name,
          data: { positionId: disc.positionId },
        });
      }

      // Emit discrepancy event
      this.eventEmitter.emit(
        EVENT_NAMES.RECONCILIATION_DISCREPANCY,
        new ReconciliationDiscrepancyEvent(
          disc.positionId,
          disc.pairId,
          disc.discrepancyType,
          disc.localState,
          disc.platformState,
          disc.recommendedAction,
        ),
      );
    }

    // Emit SystemHealthError (AC3: code 4005, critical severity)
    const healthError = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.RECONCILIATION_DISCREPANCY,
      `Reconciliation found ${discrepancies.length} discrepancy(ies)`,
      'critical',
      'StartupReconciliationService',
    );
    this.eventEmitter.emit(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL, healthError);

    // Halt trading
    this.riskManager.haltTrading('reconciliation_discrepancy');
  }

  private getRecommendedStatus(
    disc: ReconciliationDiscrepancy,
  ): PositionStatus {
    switch (disc.discrepancyType) {
      case 'pending_filled':
        return 'OPEN';
      case 'order_not_found':
      case 'order_status_mismatch':
        return 'CLOSED';
      case 'platform_unavailable':
        return 'OPEN'; // Assume still open, operator can override
      default:
        return 'CLOSED';
    }
  }

  private async recalculateRiskBudget(): Promise<void> {
    const activePositions = await this.positionRepository.findActivePositions();

    // Position count: EXCLUDE RECONCILIATION_REQUIRED
    const openCount = activePositions.filter(
      (p) =>
        p.status === 'OPEN' ||
        p.status === 'SINGLE_LEG_EXPOSED' ||
        p.status === 'EXIT_PARTIAL',
    ).length;

    // Capital deployed: INCLUDE ALL active positions including RECONCILIATION_REQUIRED
    const capitalDeployed = activePositions.reduce((sum, pos) => {
      const kalshiCapital =
        pos.kalshiOrder?.fillPrice && pos.kalshiOrder?.fillSize
          ? new Decimal(pos.kalshiOrder.fillSize.toString()).mul(
              new Decimal(pos.kalshiOrder.fillPrice.toString()),
            )
          : new Decimal(0);
      const polyCapital =
        pos.polymarketOrder?.fillPrice && pos.polymarketOrder?.fillSize
          ? new Decimal(pos.polymarketOrder.fillSize.toString()).mul(
              new Decimal(pos.polymarketOrder.fillPrice.toString()),
            )
          : new Decimal(0);
      return sum.plus(kalshiCapital).plus(polyCapital);
    }, new Decimal(0));

    await this.riskManager.recalculateFromPositions(openCount, capitalDeployed);
  }

  private callWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`API call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}
