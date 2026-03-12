import { ApiProperty } from '@nestjs/swagger';

export class ClusterExposureDto {
  @ApiProperty() clusterId!: string;
  @ApiProperty() clusterName!: string;
  @ApiProperty() exposureUsd!: string;
  @ApiProperty() exposurePct!: string;
  @ApiProperty() pairCount!: number;
}

export class ClusterOverrideResponseDto {
  @ApiProperty() data!: {
    oldClusterId: string | null;
    newClusterId: string;
  };
  @ApiProperty() timestamp!: string;
}

export class ClusterListResponseDto {
  @ApiProperty({ type: [ClusterExposureDto] }) data!: ClusterExposureDto[];
  @ApiProperty() count!: number;
  @ApiProperty() timestamp!: string;
}
