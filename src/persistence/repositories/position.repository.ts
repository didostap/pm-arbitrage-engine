import { Injectable } from '@nestjs/common';
import { Prisma, Platform } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../../common/prisma.service';
import type { PositionId, PairId } from '../../common/types/branded.type';
import { withModeFilter } from './mode-filter.helper';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';

@Injectable()
export class PositionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.OpenPositionCreateInput) {
    return this.prisma.openPosition.create({ data });
  }

  async findById(positionId: PositionId | string) {
    return this.prisma.openPosition.findUnique({ where: { positionId } });
  }

  async findByPairId(pairId: PairId | string) {
    return this.prisma.openPosition.findMany({ where: { pairId } });
  }

  async findByStatus(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean,
  ) {
    return this.prisma.openPosition.findMany({
      where: { status, ...withModeFilter(isPaper) },
    });
  }

  /** Fetches positions by status with associated ContractMatch included. */
  async findByStatusWithPair(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean,
  ) {
    return this.prisma.openPosition.findMany({
      where: { status, ...withModeFilter(isPaper) },
      include: { pair: true },
    });
  }

  /**
   * Fetches positions by status with ContractMatch, kalshiOrder, and polymarketOrder included.
   * Used by exit monitor to access entry fill prices for P&L calculation without N+1 queries.
   */
  async findByStatusWithOrders(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean,
  ) {
    return this.prisma.openPosition.findMany({
      where: { status, ...withModeFilter(isPaper) },
      include: { pair: true, kalshiOrder: true, polymarketOrder: true },
    });
  }

  async updateStatus(
    positionId: PositionId | string,
    status: Prisma.OpenPositionUpdateInput['status'],
  ) {
    return this.prisma.openPosition.update({
      where: { positionId },
      data: { status },
    });
  }

  /**
   * Transitions a position to CLOSED with realizedPnl persistence.
   * Guards against NaN/Infinity — throws SystemHealthError(4009) if realizedPnl is not finite.
   */
  async closePosition(positionId: PositionId | string, realizedPnl: Decimal) {
    if (!realizedPnl.isFinite()) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_PNL_COMPUTATION,
        `Computed realizedPnl is not finite: ${realizedPnl.toString()}`,
        'critical',
        'PositionRepository',
      );
    }
    return this.prisma.openPosition.update({
      where: { positionId },
      data: { status: 'CLOSED', realizedPnl: realizedPnl.toDecimalPlaces(8) },
    });
  }

  /**
   * Updates status and accumulates realizedPnl (existingPnl + pnlDelta).
   * Used during partial exits to incrementally persist P&L.
   * Guards against NaN/Infinity — throws SystemHealthError(4009) if pnlDelta is not finite.
   */
  async updateStatusWithAccumulatedPnl(
    positionId: PositionId | string,
    status: Prisma.OpenPositionUpdateInput['status'],
    pnlDelta: Decimal,
    existingPnl: Decimal,
  ) {
    if (!pnlDelta.isFinite()) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_PNL_COMPUTATION,
        `Computed pnlDelta is not finite: ${pnlDelta.toString()}`,
        'critical',
        'PositionRepository',
      );
    }
    const accumulated = existingPnl.plus(pnlDelta).toDecimalPlaces(8);
    return this.prisma.openPosition.update({
      where: { positionId },
      data: { status, realizedPnl: accumulated },
    });
  }

  /** Fetches position with its associated ContractMatch for contract ID resolution. */
  async findByIdWithPair(positionId: PositionId | string) {
    return this.prisma.openPosition.findUnique({
      where: { positionId },
      include: { pair: true },
    });
  }

  /** Fetches position with pair + both entry orders for close/P&L operations. */
  async findByIdWithOrders(positionId: PositionId | string) {
    return this.prisma.openPosition.findUnique({
      where: { positionId },
      include: { pair: true, kalshiOrder: true, polymarketOrder: true },
    });
  }

  /**
   * Finds all active positions (OPEN, SINGLE_LEG_EXPOSED, EXIT_PARTIAL, RECONCILIATION_REQUIRED)
   * with associated pair, kalshiOrder, and polymarketOrder for reconciliation.
   */
  async findActivePositions(isPaper: boolean) {
    return this.prisma.openPosition.findMany({
      where: {
        ...withModeFilter(isPaper),
        status: {
          in: [
            'OPEN',
            'SINGLE_LEG_EXPOSED',
            'EXIT_PARTIAL',
            'RECONCILIATION_REQUIRED',
          ],
        },
      },
      include: { pair: true, kalshiOrder: true, polymarketOrder: true },
    });
  }

  /**
   * Fetches positions with flexible status filtering and pagination.
   * When statuses is undefined or empty, returns ALL positions (no status filter).
   * Includes pair, kalshiOrder, polymarketOrder for enrichment and P&L computation.
   */
  /**
   * Dashboard query method — supports `isPaper: undefined` for "show all modes".
   * When isPaper is provided, applies withModeFilter; when undefined, no mode filter.
   */
  async findManyWithFilters(
    statuses?: string[],
    isPaper?: boolean,
    page: number = 1,
    limit: number = 50,
    sortBy?: string,
    order?: 'asc' | 'desc',
    pairId?: string,
  ) {
    const where: Record<string, unknown> = {};

    if (statuses && statuses.length > 0) {
      where['status'] = { in: statuses };
    }

    if (isPaper !== undefined) {
      Object.assign(where, withModeFilter(isPaper));
    }

    if (pairId) {
      where['pairId'] = pairId;
    }

    const skip = (page - 1) * limit;

    const orderBy = sortBy
      ? { [sortBy]: order ?? 'desc' }
      : { updatedAt: 'desc' as const };

    const [data, count] = await Promise.all([
      this.prisma.openPosition.findMany({
        where,
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.openPosition.count({ where }),
    ]);

    return { data, count };
  }

  async updateWithOrder(
    positionId: PositionId | string,
    data: Prisma.OpenPositionUpdateInput,
  ) {
    return this.prisma.openPosition.update({
      where: { positionId },
      data,
    });
  }

  /** Counts positions with a given status, mode-scoped. */
  async countByStatus(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean,
  ): Promise<number> {
    return this.prisma.openPosition.count({
      where: { status, ...withModeFilter(isPaper) },
    });
  }

  /** Counts positions closed within a date range, mode-scoped. */
  async countClosedByDateRange(
    startDate: Date,
    endDate: Date,
    isPaper: boolean,
  ): Promise<number> {
    return this.prisma.openPosition.count({
      where: {
        status: 'CLOSED',
        updatedAt: { gte: startDate, lte: endDate },
        ...withModeFilter(isPaper),
      },
    });
  }

  /**
   * Sums realized P&L for positions closed in date range, mode-scoped.
   * Uses COALESCE(realized_pnl, expected_edge) to handle historic positions
   * closed before realizedPnl was implemented.
   */
  async sumClosedPnlByDateRange(
    startDate: Date,
    endDate: Date,
    isPaper: boolean,
  ): Promise<string> {
    const result = await this.prisma.$queryRaw<[{ total: string | null }]>`
      SELECT COALESCE(SUM(COALESCE(realized_pnl, expected_edge)), 0)::text AS total
      FROM open_positions
      WHERE status = 'CLOSED'
        AND updated_at >= ${startDate}
        AND updated_at <= ${endDate}
        AND is_paper = ${isPaper}
    `; // -- MODE-FILTERED
    return result[0]?.total ?? '0';
  }

  /**
   * Counts orders by platform within a date range, mode-scoped.
   * Used by tax report for per-platform trade counts.
   */
  async countOrdersByPlatformAndDateRange(
    platform: Platform,
    startDate: Date,
    endDate: Date,
    isPaper: boolean,
  ): Promise<number> {
    return this.prisma.order.count({
      where: {
        platform,
        createdAt: { gte: startDate, lte: endDate },
        ...withModeFilter(isPaper),
      },
    });
  }

  /**
   * Finds positions by their associated order IDs (kalshi or polymarket leg).
   * Returns minimal projection for building orderId→positionId lookup maps.
   */
  /**
   * Batch-fetch latest position creation date per pair, mode-scoped.
   * Returns Map<pairId, Date> across ALL statuses (cooldown applies regardless of status).
   */
  async getLatestPositionDateByPairIds(
    pairIds: string[],
    isPaper: boolean,
  ): Promise<Map<string, Date>> {
    if (pairIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      { pair_id: string; latest: Date }[]
    >`
      SELECT pair_id, MAX(created_at) AS latest
      FROM open_positions
      WHERE pair_id IN (${Prisma.join(pairIds)})
        AND is_paper = ${isPaper}
      GROUP BY pair_id -- MODE-FILTERED
    `;
    const map = new Map<string, Date>();
    for (const row of rows) {
      map.set(row.pair_id, row.latest);
    }
    return map;
  }

  /**
   * Batch-fetch active position counts per pair, mode-scoped.
   * Returns Map<pairId, count> for active positions
   * (OPEN, SINGLE_LEG_EXPOSED, EXIT_PARTIAL, RECONCILIATION_REQUIRED).
   */
  async getActivePositionCountsByPair(
    isPaper: boolean,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<
      { pair_id: string; count: bigint }[]
    >`
      SELECT pair_id, COUNT(*) AS count
      FROM open_positions
      WHERE status IN ('OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL', 'RECONCILIATION_REQUIRED')
        AND is_paper = ${isPaper}
      GROUP BY pair_id -- MODE-FILTERED
    `;
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.pair_id, Number(row.count));
    }
    return map;
  }

  async findByOrderIds(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    return this.prisma.openPosition.findMany({
      where: {
        OR: [
          { kalshiOrderId: { in: orderIds } },
          { polymarketOrderId: { in: orderIds } },
        ],
      },
      select: {
        positionId: true,
        kalshiOrderId: true,
        polymarketOrderId: true,
      },
    });
  }
}
