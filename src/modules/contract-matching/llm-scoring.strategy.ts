import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';

import type {
  IScoringStrategy,
  ScoringResult,
  ResolutionContext,
} from '../../common/interfaces/scoring-strategy.interface.js';
import {
  LlmScoringError,
  LLM_SCORING_ERROR_CODES,
} from '../../common/errors/llm-scoring-error.js';

function buildResolutionSection(
  resolutionContext: ResolutionContext,
  category?: string,
): string {
  if (resolutionContext.totalResolved === 0) return '';

  const label = category ? `category "${category}"` : 'all categories';
  let section = `\n\nHistorical Resolution Data for ${label}:\n- ${resolutionContext.totalResolved} matches resolved, ${resolutionContext.divergedCount} diverged (${(resolutionContext.divergenceRate * 100).toFixed(1)}% divergence rate)\n- Factor this historical accuracy into your confidence assessment`;

  if (resolutionContext.divergedExamples.length > 0) {
    section += '\n- Recent divergences:';
    for (const ex of resolutionContext.divergedExamples) {
      section += `\n  • "${ex.polyDesc}" vs "${ex.kalshiDesc}" (Poly: ${ex.polyRes}, Kalshi: ${ex.kalshiRes})`;
    }
  }

  // Truncate to 500 chars max to stay within token budget
  if (section.length > 500) {
    section = section.slice(0, 497) + '...';
  }

  return section;
}

function buildPrompt(
  polyDescription: string,
  kalshiDescription: string,
  metadata?: {
    resolutionDate?: Date;
    category?: string;
    resolutionContext?: ResolutionContext;
  },
): string {
  let context = '';
  if (metadata?.resolutionDate) {
    context += `\nSettlement date: ${metadata.resolutionDate.toISOString().split('T')[0]}`;
  }
  if (metadata?.category) {
    context += `\nCategory: ${metadata.category}`;
  }

  let resolutionSection = '';
  if (metadata?.resolutionContext) {
    resolutionSection = buildResolutionSection(
      metadata.resolutionContext,
      metadata.category,
    );
  }

  return `You are a prediction market contract matching expert. Determine if these two contracts are FUNCTIONALLY IDENTICAL — meaning a YES on one platform corresponds to the same real-world outcome as a YES on the other.

Contract A (Polymarket): ${polyDescription}
Contract B (Kalshi): ${kalshiDescription}${context}${resolutionSection}

CRITICAL RULE — Outcome specificity:
Contracts about the SAME broader event but DIFFERENT specific outcomes are NOT matches. Score them 0-10.
Examples of NON-matches (same event, different outcome):
- "Will Party X win the election?" vs "Will Party Y win the election?" — different parties
- "Will Candidate A win?" vs "Will Candidate B win?" — different candidates
- "Will Bitcoin exceed $100k?" vs "Will Bitcoin exceed $150k?" — different thresholds
- "Will unemployment be above 5%?" vs "Will unemployment be above 6%?" — different thresholds

Analyze in this order:
1. OUTCOME IDENTITY: Do both contracts resolve YES under the exact same condition? Identify the specific entity, party, candidate, person, team, threshold, or metric each contract bets on. If they differ, stop here and score 0-10.
2. EVENT IDENTITY: Do they reference the same underlying real-world event?
3. SETTLEMENT ALIGNMENT: Do resolution/settlement criteria and dates match?

Respond with ONLY a JSON object (no markdown, no code blocks):
{"score": <0-100>, "confidence": "<high|medium|low>", "reasoning": "<brief explanation>"}`;
}

function parseResponse(
  text: string,
  model: string,
  provider: string,
): { score: number; confidence: 'high' | 'medium' | 'low'; reasoning: string } {
  // Try to extract JSON from the response
  let jsonStr = text.trim();

  // Handle markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      `Failed to parse LLM response as JSON: ${text.slice(0, 200)}`,
      model,
      provider,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const score = Number(obj.score);

  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      `LLM returned score outside valid range [0-100]: ${String(obj.score)}`,
      model,
      provider,
    );
  }

  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
  const rawConfidence = (
    typeof obj.confidence === 'string' ? obj.confidence : ''
  )
    .toLowerCase()
    .trim();
  if (!VALID_CONFIDENCE.has(rawConfidence)) {
    throw new LlmScoringError(
      LLM_SCORING_ERROR_CODES.LLM_RESPONSE_PARSE_FAILURE,
      `LLM returned invalid confidence level: ${String(obj.confidence)}`,
      model,
      provider,
    );
  }
  const confidence = rawConfidence as 'high' | 'medium' | 'low';
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  return { score, confidence, reasoning };
}

@Injectable()
export class LlmScoringStrategy implements IScoringStrategy {
  private readonly logger = new Logger(LlmScoringStrategy.name);

  private readonly primaryProvider: string;
  private readonly primaryModel: string;
  private readonly primaryApiKey: string;
  private readonly escalationProvider: string;
  private readonly escalationModel: string;
  private readonly escalationApiKey: string;
  private readonly escalationMin: number;
  private readonly escalationMax: number;
  private readonly maxTokens: number;
  private geminiClient: GoogleGenAI | null = null;
  private anthropicClient: Anthropic | null = null;

  constructor(private readonly configService: ConfigService) {
    this.primaryProvider = this.configService.get<string>(
      'LLM_PRIMARY_PROVIDER',
      'gemini',
    );
    this.primaryModel = this.configService.get<string>(
      'LLM_PRIMARY_MODEL',
      'gemini-2.5-flash',
    );
    this.primaryApiKey = this.configService.get<string>(
      'LLM_PRIMARY_API_KEY',
      '',
    );
    this.escalationProvider = this.configService.get<string>(
      'LLM_ESCALATION_PROVIDER',
      'anthropic',
    );
    this.escalationModel = this.configService.get<string>(
      'LLM_ESCALATION_MODEL',
      'claude-haiku-4-5-20251001',
    );
    this.escalationApiKey = this.configService.get<string>(
      'LLM_ESCALATION_API_KEY',
      '',
    );
    this.escalationMin = this.configService.get<number>(
      'LLM_ESCALATION_MIN',
      60,
    );
    this.escalationMax = this.configService.get<number>(
      'LLM_ESCALATION_MAX',
      84,
    );
    this.maxTokens = Number(
      this.configService.get<number>('LLM_MAX_TOKENS', 1024),
    );

    if (!this.primaryApiKey) {
      this.logger.warn({
        message:
          'LLM_PRIMARY_API_KEY is empty — scoring calls will fail until configured',
      });
    }
    if (!this.escalationApiKey) {
      this.logger.warn({
        message:
          'LLM_ESCALATION_API_KEY is empty — escalation scoring will fail until configured',
      });
    }
  }

  async scoreMatch(
    polyDescription: string,
    kalshiDescription: string,
    metadata?: {
      resolutionDate?: Date;
      category?: string;
      resolutionContext?: ResolutionContext;
    },
  ): Promise<ScoringResult> {
    const prompt = buildPrompt(polyDescription, kalshiDescription, metadata);

    try {
      // Primary scoring
      const primaryResult = await this.callLlm(
        this.primaryProvider,
        this.primaryModel,
        this.primaryApiKey,
        prompt,
      );

      // Check if escalation is needed
      if (
        primaryResult.score >= this.escalationMin &&
        primaryResult.score <= this.escalationMax
      ) {
        this.logger.log({
          message: 'Score in ambiguous zone, escalating',
          data: {
            primaryScore: primaryResult.score,
            escalationMin: this.escalationMin,
            escalationMax: this.escalationMax,
          },
        });

        let escalationResult: {
          score: number;
          confidence: 'high' | 'medium' | 'low';
          reasoning: string;
        };
        try {
          escalationResult = await this.callLlm(
            this.escalationProvider,
            this.escalationModel,
            this.escalationApiKey,
            prompt,
          );
        } catch (error) {
          // Preserve specific LlmScoringError codes (e.g., parse failure)
          // but enrich with primary score metadata for debugging
          if (error instanceof LlmScoringError) {
            throw new LlmScoringError(
              error.code,
              `Escalation failed: ${error.message}`,
              this.escalationModel,
              this.escalationProvider,
              {
                primaryScore: primaryResult.score,
                primaryModel: this.primaryModel,
                ...error.metadata,
              },
            );
          }
          throw new LlmScoringError(
            LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
            `Escalation LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
            this.escalationModel,
            this.escalationProvider,
            {
              primaryScore: primaryResult.score,
              primaryModel: this.primaryModel,
            },
          );
        }

        return {
          score: escalationResult.score,
          confidence: escalationResult.confidence,
          reasoning: escalationResult.reasoning,
          model: this.escalationModel,
          escalated: true,
        };
      }

      return {
        score: primaryResult.score,
        confidence: primaryResult.confidence,
        reasoning: primaryResult.reasoning,
        model: this.primaryModel,
        escalated: false,
      };
    } catch (error) {
      // Re-throw LlmScoringError with original code (e.g., parse failure 4101, escalation errors)
      if (error instanceof LlmScoringError) throw error;
      throw new LlmScoringError(
        LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
        `LLM API call failed: ${error instanceof Error ? error.message : String(error)}`,
        this.primaryModel,
        this.primaryProvider,
      );
    }
  }

  private async callLlm(
    provider: string,
    model: string,
    apiKey: string,
    prompt: string,
  ): Promise<{
    score: number;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  }> {
    try {
      if (provider === 'gemini') {
        return await this.callGemini(model, apiKey, prompt);
      } else if (provider === 'anthropic') {
        return await this.callAnthropic(model, apiKey, prompt);
      }
      throw new Error(`Unsupported LLM provider: ${provider}`);
    } catch (error) {
      if (error instanceof LlmScoringError) {
        throw error;
      }
      throw new LlmScoringError(
        LLM_SCORING_ERROR_CODES.LLM_API_FAILURE,
        `LLM API call failed: ${error instanceof Error ? error.message : String(error)}`,
        model,
        provider,
      );
    }
  }

  private async callGemini(
    model: string,
    apiKey: string,
    prompt: string,
  ): Promise<{
    score: number;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  }> {
    if (!this.geminiClient) {
      this.geminiClient = new GoogleGenAI({ apiKey });
    }
    const response = await this.geminiClient.models.generateContent({
      model,
      contents: prompt,
    });
    const text = response.text ?? '';
    return parseResponse(text, model, 'gemini');
  }

  private async callAnthropic(
    model: string,
    apiKey: string,
    prompt: string,
  ): Promise<{
    score: number;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  }> {
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({ apiKey });
    }
    const response = await this.anthropicClient.messages.create({
      model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock && 'text' in textBlock ? textBlock.text : '';
    return parseResponse(text, model, 'anthropic');
  }
}
