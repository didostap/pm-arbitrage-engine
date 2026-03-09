import type { RetryStrategy } from './system-error.js';
import { SystemHealthError } from './system-health-error.js';

export const LLM_SCORING_ERROR_CODES = {
  /** LLM API call failure (network, auth, server error) */
  LLM_API_FAILURE: 4100,
  /** LLM response could not be parsed as valid JSON */
  LLM_RESPONSE_PARSE_FAILURE: 4101,
  /** LLM API call timed out */
  LLM_TIMEOUT: 4102,
  /** LLM API rate limited */
  LLM_RATE_LIMITED: 4103,
} as const;

const RETRYABLE_STRATEGY: RetryStrategy = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

const NO_RETRY_STRATEGY: RetryStrategy = {
  maxRetries: 0,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 0,
};

const NON_RETRYABLE_CODES = new Set<number>([
  LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
]);

export class LlmScoringError extends SystemHealthError {
  constructor(
    code: number,
    message: string,
    public readonly model: string,
    public readonly provider: string,
    metadata?: Record<string, unknown>,
  ) {
    const retry = NON_RETRYABLE_CODES.has(code)
      ? NO_RETRY_STRATEGY
      : RETRYABLE_STRATEGY;

    super(code, message, 'error', 'llm-scoring', retry, metadata);
  }
}
