import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { LlmScoringStrategy } from './llm-scoring.strategy';
import {
  LlmScoringError,
  LLM_SCORING_ERROR_CODES,
} from '../../common/errors/llm-scoring-error';

// Mock @google/genai
const mockGeminiGenerate = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = { generateContent: mockGeminiGenerate };
    },
  };
});

// Mock @anthropic-ai/sdk
const mockAnthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockAnthropicCreate };
    },
  };
});

function buildConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  const defaults: Record<string, unknown> = {
    LLM_PRIMARY_PROVIDER: 'gemini',
    LLM_PRIMARY_MODEL: 'gemini-2.5-flash',
    LLM_PRIMARY_API_KEY: 'test-gemini-key',
    LLM_ESCALATION_PROVIDER: 'anthropic',
    LLM_ESCALATION_MODEL: 'claude-haiku-4-5-20251001',
    LLM_ESCALATION_API_KEY: 'test-anthropic-key',
    LLM_ESCALATION_MIN: 60,
    LLM_ESCALATION_MAX: 84,
    LLM_MAX_TOKENS: 1024,
    LLM_TIMEOUT_MS: 30000,
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => defaults[key]),
  } as unknown as ConfigService;
}

function geminiResponse(json: object) {
  return {
    text: JSON.stringify(json),
  };
}

function anthropicResponse(json: object) {
  return {
    content: [{ type: 'text', text: JSON.stringify(json) }],
  };
}

describe('LlmScoringStrategy', () => {
  let strategy: LlmScoringStrategy;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = buildConfigService();
    strategy = new LlmScoringStrategy(configService);
  });

  describe('primary scoring happy path', () => {
    it('should return score from primary model when score is above escalation max', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 92,
          confidence: 'high',
          reasoning: 'Same event, same settlement criteria',
        }),
      );

      const result = await strategy.scoreMatch(
        'Will Bitcoin exceed $100k by Dec 2026?',
        'Bitcoin above $100,000 on December 31, 2026',
      );

      expect(result.score).toBe(92);
      expect(result.confidence).toBe('high');
      expect(result.reasoning).toBe('Same event, same settlement criteria');
      expect(result.model).toBe('gemini-2.5-flash');
      expect(result.escalated).toBe(false);
    });

    it('should not escalate for score below escalation min', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 30,
          confidence: 'low',
          reasoning: 'Different events entirely',
        }),
      );

      const result = await strategy.scoreMatch('Event A', 'Event B');

      expect(result.score).toBe(30);
      expect(result.escalated).toBe(false);
      expect(result.model).toBe('gemini-2.5-flash');
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });
  });

  describe('escalation in ambiguous zone', () => {
    it('should escalate when primary score is in ambiguous zone', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 72,
          confidence: 'medium',
          reasoning: 'Possibly same event but uncertain',
        }),
      );
      mockAnthropicCreate.mockResolvedValue(
        anthropicResponse({
          score: 88,
          confidence: 'high',
          reasoning: 'Confirmed same event after deeper analysis',
        }),
      );

      const result = await strategy.scoreMatch(
        'Will the Fed cut rates?',
        'Federal Reserve rate cut by March 2026',
      );

      expect(result.score).toBe(88);
      expect(result.confidence).toBe('high');
      expect(result.model).toBe('claude-haiku-4-5-20251001');
      expect(result.escalated).toBe(true);
    });

    it('should escalate when score equals escalation min boundary', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({ score: 60, confidence: 'medium', reasoning: 'edge' }),
      );
      mockAnthropicCreate.mockResolvedValue(
        anthropicResponse({ score: 45, confidence: 'low', reasoning: 'nope' }),
      );

      const result = await strategy.scoreMatch('A', 'B');

      expect(result.escalated).toBe(true);
      expect(result.score).toBe(45);
    });

    it('should escalate when score equals escalation max boundary', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 84,
          confidence: 'medium',
          reasoning: 'almost',
        }),
      );
      mockAnthropicCreate.mockResolvedValue(
        anthropicResponse({
          score: 91,
          confidence: 'high',
          reasoning: 'yes',
        }),
      );

      const result = await strategy.scoreMatch('A', 'B');

      expect(result.escalated).toBe(true);
      expect(result.score).toBe(91);
    });
  });

  describe('no escalation for clear scores', () => {
    it('should not escalate for score just below escalation min', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({ score: 59, confidence: 'low', reasoning: 'no' }),
      );

      const result = await strategy.scoreMatch('A', 'B');

      expect(result.escalated).toBe(false);
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });

    it('should not escalate for score just above escalation max', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({ score: 85, confidence: 'high', reasoning: 'yes' }),
      );

      const result = await strategy.scoreMatch('A', 'B');

      expect(result.escalated).toBe(false);
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });
  });

  describe('API errors', () => {
    it('should throw LlmScoringError on primary API failure', async () => {
      mockGeminiGenerate.mockRejectedValue(new Error('Network error'));

      await expect(strategy.scoreMatch('A', 'B')).rejects.toThrow(
        LlmScoringError,
      );
      await expect(strategy.scoreMatch('A', 'B')).rejects.toMatchObject({
        code: LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
        model: 'gemini-2.5-flash',
        provider: 'gemini',
      });
    });

    it('should throw LlmScoringError on escalation API failure with primary score in metadata', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 72,
          confidence: 'medium',
          reasoning: 'uncertain',
        }),
      );
      mockAnthropicCreate.mockRejectedValue(new Error('Anthropic down'));

      await expect(strategy.scoreMatch('A', 'B')).rejects.toMatchObject({
        code: LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        metadata: {
          primaryScore: 72,
          primaryModel: 'gemini-2.5-flash',
        },
      });
    });
  });

  describe('response parse failures', () => {
    it('should throw LlmScoringError when response is not valid JSON', async () => {
      mockGeminiGenerate.mockResolvedValue({ text: 'not json at all' });

      await expect(strategy.scoreMatch('A', 'B')).rejects.toMatchObject({
        code: LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
        model: 'gemini-2.5-flash',
        provider: 'gemini',
      });
    });

    it('should throw when LLM returns score > 100', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: 150,
          confidence: 'high',
          reasoning: 'oops',
        }),
      );

      await expect(strategy.scoreMatch('A', 'B')).rejects.toMatchObject({
        code: LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      });
    });

    it('should throw when LLM returns score < 0', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({
          score: -5,
          confidence: 'low',
          reasoning: 'negative',
        }),
      );

      await expect(strategy.scoreMatch('A', 'B')).rejects.toMatchObject({
        code: LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      });
    });
  });

  describe('metadata passthrough', () => {
    it('should include resolution date and category in prompt context', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({ score: 90, confidence: 'high', reasoning: 'match' }),
      );

      await strategy.scoreMatch('A', 'B', {
        resolutionDate: new Date('2026-12-31'),
        category: 'crypto',
      });

      expect(mockGeminiGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.5-flash',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          contents: expect.stringContaining('2026-12-31'),
        }),
      );
    });
  });

  describe('prompt content', () => {
    it('should include outcome specificity instructions in the prompt', async () => {
      mockGeminiGenerate.mockResolvedValue(
        geminiResponse({ score: 90, confidence: 'high', reasoning: 'match' }),
      );

      await strategy.scoreMatch(
        'Will Party X win the election?',
        'Will Party Y win the election?',
      );

      const calledPrompt = (
        mockGeminiGenerate.mock.calls[0]![0] as { contents: string }
      ).contents;
      expect(calledPrompt).toContain('FUNCTIONALLY IDENTICAL');
      expect(calledPrompt).toContain('OUTCOME IDENTITY');
      expect(calledPrompt).toContain('different parties');
      expect(calledPrompt).toContain('Score them 0-10');
    });
  });
});
