export interface CompressionResult {
  tables: Array<{ tableName: string; chunksCompressed: number }>;
  totalChunksCompressed: number;
}

export interface TableStorageStats {
  tableName: string;
  totalSize: string;
  compressedSize: string | null;
  uncompressedSize: string | null;
  compressionRatioPct: number;
  totalChunks: number;
  compressedChunks: number;
}

export interface StorageStats {
  totalDatabaseSize: string;
  tables: TableStorageStats[];
}
