import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.OrderCreateInput) {
    return this.prisma.order.create({ data });
  }

  async findById(orderId: string) {
    return this.prisma.order.findUnique({ where: { orderId } });
  }

  async findByPairId(pairId: string) {
    return this.prisma.order.findMany({ where: { pairId } });
  }

  async updateStatus(
    orderId: string,
    status: Prisma.OrderUpdateInput['status'],
  ) {
    return this.prisma.order.update({
      where: { orderId },
      data: { status },
    });
  }

  /** Finds all orders with PENDING status. */
  async findPendingOrders(isPaper: boolean = false) {
    return this.prisma.order.findMany({
      where: { status: 'PENDING', isPaper },
    });
  }

  /** Updates order status with optional fill data. */
  async updateOrderStatus(
    orderId: string,
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
}
