import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { type OrderId, type PairId } from '../../common/types/branded.type';
import { withModeFilter } from './mode-filter.helper';

@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.OrderCreateInput) {
    return this.prisma.order.create({ data });
  }

  async findById(orderId: OrderId | string) {
    return this.prisma.order.findUnique({ where: { orderId } });
  }

  async findByPairId(pairId: PairId | string) {
    return this.prisma.order.findMany({ where: { pairId } });
  }

  async updateStatus(
    orderId: OrderId | string,
    status: Prisma.OrderUpdateInput['status'],
  ) {
    return this.prisma.order.update({
      where: { orderId },
      data: { status },
    });
  }

  /** Finds all orders with PENDING status. */
  async findPendingOrders(isPaper: boolean) {
    return this.prisma.order.findMany({
      where: { status: 'PENDING', ...withModeFilter(isPaper) },
    });
  }

  /** Updates order status with optional fill data. */
  async updateOrderStatus(
    orderId: OrderId | string,
    status: Prisma.OrderUpdateInput['status'],
    fillPrice?: Prisma.OrderUpdateInput['fillPrice'],
    fillSize?: Prisma.OrderUpdateInput['fillSize'],
  ) {
    const data: Prisma.OrderUpdateInput = { status };
    if (fillPrice !== undefined) data.fillPrice = fillPrice;
    if (fillSize !== undefined) data.fillSize = fillSize;
    return this.prisma.order.update({
      where: { orderId },
      data,
    });
  }

  /** Counts filled orders within a date range, mode-scoped. */
  async countByDateRange(
    startDate: Date,
    endDate: Date,
    isPaper: boolean,
  ): Promise<number> {
    return this.prisma.order.count({
      where: {
        status: 'FILLED',
        createdAt: { gte: startDate, lte: endDate },
        ...withModeFilter(isPaper),
      },
    });
  }

  /** Finds orders within a date range with pair relation. */
  async findByDateRange(
    startDate: Date,
    endDate: Date,
    options?: { isPaper?: boolean },
  ) {
    return this.prisma.order.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        ...(options?.isPaper !== undefined ? { isPaper: options.isPaper } : {}),
      },
      include: { pair: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
