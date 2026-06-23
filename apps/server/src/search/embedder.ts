/**
 * Embedding provider abstraction. Production injects a real model (e.g. OpenAI
 * text-embedding-3-small → 1536 dims). When no embedder is configured, semantic
 * search is disabled (returns nothing) and no embeddings are written.
 *
 * `HashEmbedder` is a deterministic, dependency-free embedder for dev/tests: it
 * hashes tokens into a normalized vector, so texts sharing tokens land near each
 * other under cosine distance. It exercises the full pgvector path without an
 * external API.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export class HashEmbedder implements Embedder {
  readonly dimensions: number;
  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dimensions;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
