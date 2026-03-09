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
    metadata?: { resolutionDate?: Date; category?: string },
  ): Promise<ScoringResult>;
}
