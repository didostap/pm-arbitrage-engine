import { Injectable } from '@nestjs/common';

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'not',
  'no',
  'if',
  'then',
  'than',
  'so',
  'as',
  'up',
  'out',
  'about',
  'into',
  'over',
  'after',
  'before',
]);

const TFIDF_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

export interface SimilarityResult {
  tfidfScore: number;
  keywordOverlap: number;
  combinedScore: number;
}

export interface FilterCandidate {
  id: string;
  description: string;
}

export interface RankedCandidate extends FilterCandidate {
  combinedScore: number;
  tfidfScore: number;
  keywordOverlap: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

function cosineSimilarity(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Map<string, number>,
): number {
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  if (allTerms.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const idfVal = idf.get(term) ?? 1;
    const a = (tfA.get(term) ?? 0) * idfVal;
    const b = (tfB.get(term) ?? 0) * idfVal;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}

function extractKeywords(text: string): string[] {
  const dates = text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g) ?? [];
  const percentages = text.match(/\d+\.?\d*%/g) ?? [];
  const outcomes =
    text.match(/\b(yes|no|true|false|win|lose|above|below|over|under)\b/gi) ??
    [];
  const numbers = text.match(/\b\d+\.?\d*\b/g) ?? [];
  return [...dates, ...percentages, ...outcomes, ...numbers].map((s) =>
    s.toLowerCase(),
  );
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

@Injectable()
export class PreFilterService {
  computeSimilarity(
    descriptionA: string,
    descriptionB: string,
  ): SimilarityResult {
    const tokensA = tokenize(descriptionA);
    const tokensB = tokenize(descriptionB);

    // TF-IDF with 2-document IDF
    const tfA = termFrequency(tokensA);
    const tfB = termFrequency(tokensB);

    // IDF with smoothing for 2-document comparison:
    // Terms unique to one doc get higher weight than shared terms.
    // Formula: 1 + log(N / docsContaining) where N=2
    const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
    const idf = new Map<string, number>();
    for (const term of allTerms) {
      const docsContaining = (tfA.has(term) ? 1 : 0) + (tfB.has(term) ? 1 : 0);
      idf.set(term, 1 + Math.log(2 / docsContaining));
    }

    const tfidfScore = cosineSimilarity(tfA, tfB, idf);

    // Keyword overlap (Jaccard)
    const keywordsA = new Set(extractKeywords(descriptionA));
    const keywordsB = new Set(extractKeywords(descriptionB));
    const keywordOverlap = jaccardSimilarity(keywordsA, keywordsB);

    // Combined
    const combinedScore =
      TFIDF_WEIGHT * tfidfScore + KEYWORD_WEIGHT * keywordOverlap;

    return { tfidfScore, keywordOverlap, combinedScore };
  }

  filterCandidates(
    sourceDescription: string,
    candidates: FilterCandidate[],
    threshold: number,
  ): RankedCandidate[] {
    const ranked: RankedCandidate[] = [];

    for (const candidate of candidates) {
      const { tfidfScore, keywordOverlap, combinedScore } =
        this.computeSimilarity(sourceDescription, candidate.description);

      if (combinedScore >= threshold) {
        ranked.push({
          ...candidate,
          combinedScore,
          tfidfScore,
          keywordOverlap,
        });
      }
    }

    return ranked.sort((a, b) => b.combinedScore - a.combinedScore);
  }
}
