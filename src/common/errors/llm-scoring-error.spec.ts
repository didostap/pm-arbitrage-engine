import { describe, it, expect } from 'vitest';
import { LlmScoringError, LLM_SCORING_ERROR_CODES } from './llm-scoring-error';

describe('LlmScoringError', () => {
  it('should create error with model and provider fields', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
      'Gemini API returned 500',
      'gemini-2.5-flash',
      'gemini',
    );

    expect(error.code).toBe(4100);
    expect(error.message).toBe('Gemini API returned 500');
    expect(error.model).toBe('gemini-2.5-flash');
    expect(error.provider).toBe('gemini');
    expect(error.severity).toBe('error');
    expect(error.name).toBe('LlmScoringError');
  });

  it('should have error codes in 4100-4199 range', () => {
    expect(LLM_SCORING_ERROR_CODES.LLM_API_FAILURE).toBe(4100);
    expect(LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE).toBe(4101);
    expect(LLM_SCORING_ERROR_CODES.LLM_TIMEOUT).toBe(4102);
    expect(LLM_SCORING_ERROR_CODES.LLM_RATE_LIMITED).toBe(4103);
  });

  it('should have retry strategy for LLM_API_FAILURE (maxRetries: 2)', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
      'API failure',
      'gemini-2.5-flash',
      'gemini',
    );

    expect(error.retryStrategy).toEqual({
      maxRetries: 2,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });
  });

  it('should have no retry for LLM_RESPONSE_PARSE_FAILURE (maxRetries: 0)', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      'Invalid JSON',
      'gemini-2.5-flash',
      'gemini',
    );

    expect(error.retryStrategy).toEqual({
      maxRetries: 0,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 0,
    });
  });

  it('should have retry strategy for LLM_TIMEOUT', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_TIMEOUT,
      'Request timed out',
      'claude-haiku-4-5-20251001',
      'anthropic',
    );

    expect(error.retryStrategy).toEqual({
      maxRetries: 2,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });
  });

  it('should have retry strategy for LLM_RATE_LIMITED', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_RATE_LIMITED,
      'Rate limited',
      'gemini-2.5-flash',
      'gemini',
    );

    expect(error.retryStrategy).toEqual({
      maxRetries: 2,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });
  });

  it('should include metadata when provided', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
      'Escalation failed',
      'claude-haiku-4-5-20251001',
      'anthropic',
      { primaryScore: 72, primaryModel: 'gemini-2.5-flash' },
    );

    expect(error.metadata).toEqual({
      primaryScore: 72,
      primaryModel: 'gemini-2.5-flash',
    });
  });

  it('should extend Error prototype chain', () => {
    const error = new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
      'test',
      'model',
      'provider',
    );

    expect(error).toBeInstanceOf(Error);
  });
});
