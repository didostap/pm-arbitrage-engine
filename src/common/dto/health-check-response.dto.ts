import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ example: 'pm-arbitrage-engine' })
  service!: string;
}

export class HealthCheckResponseDto {
  @ApiProperty({ type: HealthStatusDto })
  data!: HealthStatusDto;

  @ApiProperty({ description: 'Response timestamp (ISO 8601)' })
  timestamp!: string;
}
