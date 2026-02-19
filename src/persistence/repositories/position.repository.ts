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

  async findByStatus(status: Prisma.OpenPositionWhereInput['status']) {
    return this.prisma.openPosition.findMany({ where: { status } });
  }

  /** Fetches positions by status with associated ContractMatch included. */
  async findByStatusWithPair(status: Prisma.OpenPositionWhereInput['status']) {
    return this.prisma.openPosition.findMany({
      where: { status },
      include: { pair: true },
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
