import { Module } from '@nestjs/common';
import { ContractMatchingModule } from '../contract-matching/contract-matching.module';
import { DataIngestionModule } from '../data-ingestion/data-ingestion.module';
import { ConnectorModule } from '../../connectors/connector.module';
import { DetectionService } from './detection.service';
import { EdgeCalculatorService } from './edge-calculator.service';

@Module({
  imports: [ContractMatchingModule, DataIngestionModule, ConnectorModule],
  providers: [DetectionService, EdgeCalculatorService],
  exports: [DetectionService, EdgeCalculatorService],
})
export class ArbitrageDetectionModule {}
