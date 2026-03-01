import { Injectable } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import {
  PrismaClientKnownRequestError,
  PrismaClientInitializationError,
  PrismaClientRustPanicError,
} from '@prisma/client/runtime/library';
import { HealthCheckResponseDto } from './common/dto/health-check-response.dto';
import { SystemHealthError } from './common/errors/system-health-error';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async getHealth(): Promise<HealthCheckResponseDto> {
    try {
      // Verify database connectivity
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        data: {
          status: 'ok',
          service: 'pm-arbitrage-engine',
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      // Map specific Prisma errors to appropriate error codes
      let message = 'Database connection failed';
      let code = 4001;

      if (error instanceof PrismaClientInitializationError) {
        message = 'Database initialization failed';
        code = 4002;
      } else if (error instanceof PrismaClientKnownRequestError) {
        message = `Database query failed: ${error.code}`;
        code = 4003;
      } else if (error instanceof PrismaClientRustPanicError) {
        message = 'Database engine panic';
        code = 4004;
      }

      throw new SystemHealthError(code, message, 'critical');
    }
  }
}
