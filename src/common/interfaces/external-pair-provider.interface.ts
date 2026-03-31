import type { ExternalMatchedPair } from '../types/index.js';

export interface IExternalPairProvider {
  fetchPairs(): Promise<ExternalMatchedPair[]>;
  getSourceId(): string;
}

export const ODDSPIPE_PAIR_PROVIDER_TOKEN = 'ODDSPIPE_PAIR_PROVIDER';
export const PREDEXON_PAIR_PROVIDER_TOKEN = 'PREDEXON_PAIR_PROVIDER';
