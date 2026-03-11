export interface ResolutionContext {
  totalResolved: number;
  divergedCount: number;
  /** Fraction (0 to 1), e.g. 0.083 = 8.3%. Multiply by 100 for percentage display. */
  divergenceRate: number;
  validatedPatterns: number;
  divergedExamples: Array<{
    matchId: string;
    polyDesc: string;
    kalshiDesc: string;
    polyRes: string;
    kalshiRes: string;
  }>;
}

export const SCORING_STRATEGY_TOKEN = 'IScoringStrategy';

export interface ScoringResult {
  score: number; // 0-100
  confidence: 'high' | 'medium' | 'low';
  reasoning: string; // LLM's explanation
  model: string; // e.g. 'gemini-2.5-flash'
  escalated: boolean; // true if escalation model was used
}

export interface IScoringStrategy {
  scoreMatch(
    polyDescription: string,
    kalshiDescription: string,
    metadata?: {
      resolutionDate?: Date;
      category?: string;
      resolutionContext?: ResolutionContext;
    },
  ): Promise<ScoringResult>;
}
