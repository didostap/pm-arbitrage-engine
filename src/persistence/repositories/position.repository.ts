import { Injectable } from '@nestjs/common';
import { Prisma, Platform } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { PositionId, PairId } from '../../common/types/branded.type';

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
    isPaper: boolean = false,
  ) {
    return this.prisma.openPosition.findMany({ where: { status, isPaper } });
  }

  /** Fetches positions by status with associated ContractMatch included. */
  async findByStatusWithPair(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean = false,
  ) {
    return this.prisma.openPosition.findMany({
      where: { status, isPaper },
      include: { pair: true },
    });
  }

  /**
   * Fetches positions by status with ContractMatch, kalshiOrder, and polymarketOrder included.
   * Used by exit monitor to access entry fill prices for P&L calculation without N+1 queries.
   */
  async findByStatusWithOrders(
    status: Prisma.OpenPositionWhereInput['status'],
    isPaper: boolean = false,
  ) {
    return this.prisma.openPosition.findMany({
      where: { status, isPaper },
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
  async findActivePositions(isPaper: boolean = false) {
    return this.prisma.openPosition.findMany({
      where: {
        isPaper,
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
      where['isPaper'] = isPaper;
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

  /** Counts all positions with a given status (both live and paper). */
  async countByStatus(
    status: Prisma.OpenPositionWhereInput['status'],
  ): Promise<number> {
    return this.prisma.openPosition.count({ where: { status } });
  }

  /** Counts positions closed within a date range. */
  async countClosedByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    return this.prisma.openPosition.count({
      where: {
        status: 'CLOSED',
        updatedAt: { gte: startDate, lte: endDate },
      },
    });
  }

  /**
   * Sums expectedEdge for positions closed in date range.
   * NOTE: This is a proxy for realized P&L — OpenPosition has no dedicated realizedPnl
   * Decimal column. The reconciliationContext JSON may contain actual P&L but extracting
   * from JSON aggregates is unreliable. True realized P&L tracking requires a schema
   * migration (deferred to Phase 1).
   */
  async sumClosedEdgeByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<string> {
    const result = await this.prisma.openPosition.aggregate({
      where: {
        status: 'CLOSED',
        updatedAt: { gte: startDate, lte: endDate },
      },
      _sum: { expectedEdge: true },
    });
    return result._sum.expectedEdge?.toString() ?? '0';
  }

  /**
   * Counts orders by platform within a date range.
   * Used by tax report for per-platform trade counts.
   */
  async countOrdersByPlatformAndDateRange(
    platform: Platform,
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    return this.prisma.order.count({
      where: {
        platform,
        createdAt: { gte: startDate, lte: endDate },
      },
    });
  }

  /**
   * Finds positions by their associated order IDs (kalshi or polymarket leg).
   * Returns minimal projection for building orderId→positionId lookup maps.
   */
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
