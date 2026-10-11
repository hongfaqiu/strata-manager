export interface LatestStoreWriter {
  stage(key: string, value: unknown): void;
  seed(key: string, value: unknown): void;
  flush(key: string): Promise<void>;
  flushAll(): Promise<void>;
}
export function createLatestStoreWriter(write: (key: string, value: unknown) => Promise<void>): LatestStoreWriter;
