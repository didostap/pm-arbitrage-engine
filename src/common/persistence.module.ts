import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global persistence module providing database access.
 * PrismaService is available to all modules without explicit imports.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PersistenceModule {}
