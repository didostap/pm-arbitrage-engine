import { RawDislocation } from './raw-dislocation.type';

export interface DetectionCycleResult {
  dislocations: RawDislocation[];
  pairsEvaluated: number;
  pairsSkipped: number;
  cycleDurationMs: number;
}
