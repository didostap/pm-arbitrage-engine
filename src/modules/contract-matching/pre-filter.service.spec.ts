import { describe, it, expect, beforeEach } from 'vitest';
import { PreFilterService } from './pre-filter.service';

describe('PreFilterService', () => {
  let service: PreFilterService;

  beforeEach(() => {
    service = new PreFilterService();
  });

  describe('computeSimilarity', () => {
    it('should return high similarity for identical descriptions', () => {
      const result = service.computeSimilarity(
        'Will Bitcoin exceed $100,000 by December 31, 2026?',
        'Will Bitcoin exceed $100,000 by December 31, 2026?',
      );

      expect(result.tfidfScore).toBeGreaterThan(0.9);
      expect(result.combinedScore).toBeGreaterThan(0.9);
    });

    it('should return low similarity for unrelated descriptions', () => {
      const result = service.computeSimilarity(
        'Will Bitcoin exceed $100,000 by December 31, 2026?',
        'Will the Lakers win the NBA championship in 2026?',
      );

      expect(result.tfidfScore).toBeLessThan(0.3);
      expect(result.combinedScore).toBeLessThan(0.3);
    });

    it('should detect keyword overlap for matching numbers and dates', () => {
      const result = service.computeSimilarity(
        'Bitcoin above $100,000 on 2026-12-31',
        'BTC price exceeds $100,000 before 2026-12-31',
      );

      expect(result.keywordOverlap).toBeGreaterThan(0);
    });

    it('should return 0 for empty input', () => {
      const result = service.computeSimilarity('', '');

      expect(result.tfidfScore).toBe(0);
      expect(result.keywordOverlap).toBe(0);
      expect(result.combinedScore).toBe(0);
    });

    it('should return 0 for whitespace-only input', () => {
      const result = service.computeSimilarity('   ', '   ');

      expect(result.tfidfScore).toBe(0);
      expect(result.combinedScore).toBe(0);
    });

    it('should handle single-word descriptions', () => {
      const result = service.computeSimilarity('bitcoin', 'bitcoin');

      expect(result.tfidfScore).toBeGreaterThan(0.9);
    });

    it('should handle single-word descriptions that differ', () => {
      const result = service.computeSimilarity('bitcoin', 'ethereum');

      expect(result.tfidfScore).toBe(0);
    });

    it('should compute combined score as weighted average of tfidf and keyword overlap', () => {
      const result = service.computeSimilarity(
        'Bitcoin price above 100000 on 2026-12-31',
        'Bitcoin exceeds 100000 by 2026-12-31',
      );

      // combinedScore should be roughly 0.6 * tfidf + 0.4 * keyword
      const expected = 0.6 * result.tfidfScore + 0.4 * result.keywordOverlap;
      expect(result.combinedScore).toBeCloseTo(expected, 5);
    });
  });

  describe('filterCandidates', () => {
    it('should return candidates above threshold sorted by score descending', () => {
      const source = 'Will Bitcoin exceed $100,000 by December 2026?';
      const candidates = [
        { id: 'c1', description: 'Bitcoin above $100,000 by end of 2026' },
        { id: 'c2', description: 'Lakers win NBA championship 2026' },
        {
          id: 'c3',
          description: 'Will BTC price be over $100,000 December 2026?',
        },
      ];

      const result = service.filterCandidates(source, candidates, 0.1);

      // Should return at least the Bitcoin-related ones
      expect(result.length).toBeGreaterThanOrEqual(1);
      // Results should be sorted by combinedScore descending
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1]!.combinedScore).toBeGreaterThanOrEqual(
          result[i]!.combinedScore,
        );
      }
    });

    it('should filter out candidates below threshold', () => {
      const source = 'Bitcoin price question';
      const candidates = [
        { id: 'c1', description: 'Completely unrelated topic about cooking' },
      ];

      const result = service.filterCandidates(source, candidates, 0.5);

      expect(result).toHaveLength(0);
    });

    it('should return empty array for empty candidates', () => {
      const result = service.filterCandidates('test', [], 0.1);
      expect(result).toHaveLength(0);
    });
  });
});
