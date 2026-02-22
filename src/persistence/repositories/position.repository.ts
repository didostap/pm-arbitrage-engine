import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class PositionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.OpenPositionCreateInput) {
    return this.prisma.openPosition.create({ data });
  }

  async findById(positionId: string) {
    return this.prisma.openPosition.findUnique({ where: { positionId } });
  }

  async findByPairId(pairId: string) {
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
    positionId: string,
    status: Prisma.OpenPositionUpdateInput['status'],
  ) {
    return this.prisma.openPosition.update({
      where: { positionId },
      data: { status },
    });
  }

  /** Fetches position with its associated ContractMatch for contract ID resolution. */
  async findByIdWithPair(positionId: string) {
    return this.prisma.openPosition.findUnique({
      where: { positionId },
      include: { pair: true },
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

  async updateWithOrder(
    positionId: string,
    data: Prisma.OpenPositionUpdateInput,
  ) {
    return this.prisma.openPosition.update({
      where: { positionId },
      data,
    });
  }
}
