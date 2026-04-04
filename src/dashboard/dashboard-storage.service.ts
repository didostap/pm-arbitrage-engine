import { Injectable } from '@nestjs/common';
import { TimescaleStorageService } from '../modules/monitoring/timescale-storage.service.js';
import type { StorageStatsDto } from './dto/storage-stats.dto.js';

@Injectable()
export class DashboardStorageService {
  constructor(
    private readonly timescaleStorageService: TimescaleStorageService,
  ) {}

  async getStorageStats(): Promise<StorageStatsDto> {
    const stats = await this.timescaleStorageService.getStorageStats();
    return {
      totalDatabaseSize: stats.totalDatabaseSize,
      tables: stats.tables.map((t) => ({
        tableName: t.tableName,
        totalSize: t.totalSize,
        compressedSize: t.compressedSize,
        uncompressedSize: t.uncompressedSize,
        compressionRatioPct: t.compressionRatioPct,
        totalChunks: t.totalChunks,
        compressedChunks: t.compressedChunks,
      })),
    };
  }
}
