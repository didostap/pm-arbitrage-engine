import { ApiProperty } from '@nestjs/swagger';

export class PlatformHealthDto {
  @ApiProperty({ description: 'Platform identifier', example: 'kalshi' })
  platformId!: string;

  @ApiProperty({
    description: 'Health status',
    enum: ['healthy', 'degraded', 'disconnected'],
  })
  status!: 'healthy' | 'degraded' | 'disconnected';

  @ApiProperty({ description: 'Whether API connection is active' })
  apiConnected!: boolean;

  @ApiProperty({ description: 'Whether data is fresh (not stale)' })
  dataFresh!: boolean;

  @ApiProperty({
    description: 'Last health update timestamp (ISO 8601)',
    example: '2026-03-01T12:00:00.000Z',
  })
  lastUpdate!: string;

  @ApiProperty({ description: 'Platform mode', enum: ['live', 'paper'] })
  mode!: 'live' | 'paper';
}
