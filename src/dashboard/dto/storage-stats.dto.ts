import { ApiProperty } from '@nestjs/swagger';

export class TableStorageStatsDto {
  @ApiProperty({ description: 'Hypertable name', example: 'historical_prices' })
  tableName!: string;

  @ApiProperty({
    description: 'Total hypertable size (human-readable)',
    example: '180 GB',
  })
  totalSize!: string;

  @ApiProperty({
    description: 'Size after compression (human-readable)',
    example: '18 GB',
    nullable: true,
  })
  compressedSize!: string | null;

  @ApiProperty({
    description: 'Size before compression (human-readable)',
    example: '180 GB',
    nullable: true,
  })
  uncompressedSize!: string | null;

  @ApiProperty({
    description: 'Compression ratio as percentage',
    example: 89.9,
  })
  compressionRatioPct!: number;

  @ApiProperty({ description: 'Total number of chunks', example: 90 })
  totalChunks!: number;

  @ApiProperty({ description: 'Number of compressed chunks', example: 80 })
  compressedChunks!: number;
}

export class StorageStatsDto {
  @ApiProperty({
    description: 'Total database size (human-readable)',
    example: '337 GB',
  })
  totalDatabaseSize!: string;

  @ApiProperty({ type: [TableStorageStatsDto] })
  tables!: TableStorageStatsDto[];
}

export class StorageStatsResponseDto {
  @ApiProperty({ type: StorageStatsDto })
  data!: StorageStatsDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
