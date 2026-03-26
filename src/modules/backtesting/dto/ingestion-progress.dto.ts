export class IngestionProgressDto {
  source!: string;
  contractId!: string;
  status!: 'pending' | 'in-progress' | 'complete' | 'failed';
  recordsIngested!: number;
  errors!: string[];
}
