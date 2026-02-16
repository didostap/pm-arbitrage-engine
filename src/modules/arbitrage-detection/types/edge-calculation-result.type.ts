import { EnrichedOpportunity } from './enriched-opportunity.type';

export interface FilteredDislocation {
  pairEventDescription: string;
  netEdge: string;
  threshold: string;
  reason: string;
}

export interface EdgeCalculationResult {
  opportunities: EnrichedOpportunity[];
  filtered: FilteredDislocation[];
  summary: {
    totalInput: number;
    totalFiltered: number;
    totalActionable: number;
    skippedErrors: number;
    processingDurationMs: number;
  };
}
