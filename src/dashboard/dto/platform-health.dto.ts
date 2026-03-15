import { ApiProperty } from '@nestjs/swagger';

export class PlatformHealthDto {
  @ApiProperty({ description: 'Platform identifier', example: 'kalshi' })
  platformId!: string;

  @ApiProperty({
    description: 'Health status',
    enum: ['healthy', 'degraded', 'disconnected', 'initializing'],
  })
  status!: 'healthy' | 'degraded' | 'disconnected' | 'initializing';

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

  @ApiProperty({ description: 'Number of active WebSocket subscriptions' })
  wsSubscriptionCount!: number;

  @ApiProperty({
    description: 'Data divergence status between poll and WebSocket paths',
    enum: ['normal', 'divergent'],
  })
  divergenceStatus!: 'normal' | 'divergent';

  @ApiProperty({
    description: 'ISO timestamp of most recent WS message received',
    nullable: true,
    example: '2026-03-01T12:00:00.000Z',
  })
  wsLastMessageTimestamp!: string | null;
}
