/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from 'vitest';
import { OutcomeDirectionValidator } from './outcome-direction-validator';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface';
import { PlatformId } from '../../common/types/platform.type';

function makePolyContract(
  overrides: Partial<ContractSummary> = {},
): ContractSummary {
  return {
    contractId: 'cond-poly',
    title: 'UFC Fight',
    description: 'Who will win?',
    platform: PlatformId.POLYMARKET,
    clobTokenId: 'token-a',
    ...overrides,
  };
}

function makeKalshiContract(
  overrides: Partial<ContractSummary> = {},
): ContractSummary {
  return {
    contractId: 'kalshi-mkt',
    title: 'UFC Fight',
    description: 'Who will win?',
    platform: PlatformId.KALSHI,
    ...overrides,
  };
}

function makeMockScoring(): IScoringStrategy {
  return {
    scoreMatch: vi.fn().mockResolvedValue({
      score: 90,
      confidence: 'high',
      reasoning: 'test',
      model: 'test',
      escalated: false,
    }),
  };
}

describe('OutcomeDirectionValidator', () => {
  let validator: OutcomeDirectionValidator;
  let mockScoring: IScoringStrategy;

  beforeEach(() => {
    mockScoring = makeMockScoring();
    validator = new OutcomeDirectionValidator(mockScoring);
  });

  describe('aligned outcomes', () => {
    it('should return aligned=true when both labels match (same participant)', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Sam Patterson wins',
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Sam Patterson wins',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
      expect(result.reason).toContain('Substring match');
    });

    it('should be case-insensitive', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'sam patterson wins',
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Sam Patterson Wins',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
    });

    it('should strip common suffixes ("wins", "will win", "to win")', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Sam Patterson wins',
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Sam Patterson will win',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
    });
  });

  describe('mismatched outcomes', () => {
    it('should return aligned=false when labels indicate different participants and no tokens available', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Fighter A wins',
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Fighter B wins',
      });

      // LLM confirms mismatch
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 20,
        confidence: 'high',
        reasoning: 'different participants',
        model: 'test',
        escalated: false,
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(false);
    });
  });

  describe('missing labels', () => {
    it('should return aligned=null when polymarket label is missing', async () => {
      const poly = makePolyContract({ outcomeLabel: undefined });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Sam Patterson wins',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBeNull();
      expect(result.reason).toContain('missing');
    });

    it('should return aligned=null when kalshi label is missing', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Sam Patterson wins',
      });
      const kalshi = makeKalshiContract({ outcomeLabel: undefined });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBeNull();
    });

    it('should return aligned=null when both labels are missing', async () => {
      const poly = makePolyContract({ outcomeLabel: undefined });
      const kalshi = makeKalshiContract({ outcomeLabel: undefined });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBeNull();
    });
  });

  describe('binary Yes/No markets', () => {
    it('should return aligned=true for standard Yes/No markets (non-head-to-head)', async () => {
      const poly = makePolyContract({ outcomeLabel: 'Yes' });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Before Jan 1, 2026',
      });

      // LLM confirms alignment
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 85,
        confidence: 'high',
        reasoning: 'aligned',
        model: 'test',
        escalated: false,
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
    });
  });

  describe('short name handling', () => {
    it('should skip substring matching for names shorter than 4 chars and use LLM', async () => {
      const poly = makePolyContract({ outcomeLabel: 'Joe wins' });
      const kalshi = makeKalshiContract({ outcomeLabel: 'Joey wins' });

      // LLM should be called since "Joe" is < 4 chars
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 85,
        confidence: 'high',
        reasoning: 'aligned',
        model: 'test',
        escalated: false,
      });

      await validator.validateDirection(poly, kalshi);
      expect(mockScoring.scoreMatch).toHaveBeenCalled();
    });
  });

  describe('self-correction (token swap)', () => {
    it('should correct clobTokenId when mismatched outcome has an aligning token', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Fighter A wins',
        clobTokenId: 'token-a',
        outcomeTokens: [
          { tokenId: 'token-a', outcomeLabel: 'Fighter A wins' },
          { tokenId: 'token-b', outcomeLabel: 'Fighter B wins' },
        ],
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Fighter B wins',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
      expect(result.correctedTokenId).toBe('token-b');
      expect(result.correctedLabel).toBe('Fighter B wins');
      expect(result.reason).toContain('Self-corrected');
    });

    it('should downgrade when no aligning token found', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Fighter A wins',
        clobTokenId: 'token-a',
        outcomeTokens: [
          { tokenId: 'token-a', outcomeLabel: 'Fighter A wins' },
          { tokenId: 'token-c', outcomeLabel: 'Fighter C wins' },
        ],
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Fighter B wins',
      });

      // LLM confirms no alignment for any token
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 20,
        confidence: 'high',
        reasoning: 'no match',
        model: 'test',
        escalated: false,
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(false);
      expect(result.correctedTokenId).toBeUndefined();
      expect(result.reason).toContain('No aligning token');
    });

    it('should downgrade when outcomeTokens is empty', async () => {
      const poly = makePolyContract({
        outcomeLabel: 'Fighter A wins',
        clobTokenId: 'token-a',
      });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Fighter B wins',
      });

      // LLM confirms mismatch
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 20,
        confidence: 'high',
        reasoning: 'different',
        model: 'test',
        escalated: false,
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(false);
      expect(result.correctedTokenId).toBeUndefined();
    });
  });

  describe('unicode normalization', () => {
    it('should normalize unicode/accented characters via NFKD', async () => {
      const poly = makePolyContract({ outcomeLabel: 'José García wins' });
      const kalshi = makeKalshiContract({
        outcomeLabel: 'Jose Garcia wins',
      });

      const result = await validator.validateDirection(poly, kalshi);
      expect(result.aligned).toBe(true);
    });
  });
});
