import { createHash } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { withRls, type RlsContext } from "../../db/tx.js";

/**
 * TRD §8 / FR-SRCH-002: the query embedding is computed in Node and passed to
 * SQL as a parameter. Providers: `mock` (deterministic, tests/dev),
 * `openai`, `voyage`. A provider failure must never 5xx a write — the caller
 * catches and leaves `embedding_stale = true` (TR §18).
 */
export type EmbeddingProvider = {
  readonly dim: number;
  readonly name: AppConfig["embeddingProvider"];
  embed(texts: string[]): Promise<number[][]>;
};

/** Deterministic unit vector from a hash, so fixtures are reproducible. */
function mockVector(text: string, dim: number): number[] {
  const out: number[] = [];
  let counter = 0;
  while (out.length < dim) {
    const digest = createHash("sha256").update(`${counter}:${text}`).digest();
    for (let i = 0; i + 1 < digest.length && out.length < dim; i += 2) {
      out.push((digest.readUInt16BE(i) / 65535) * 2 - 1);
    }
    counter += 1;
  }
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

async function embedHttp(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<number[][]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`embedding provider responded ${res.status}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((row) => row.embedding);
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  const dim = config.embeddingDim;
  if (config.embeddingProvider === "mock") {
    return {
      dim,
      name: "mock",
      embed: async (texts) => texts.map((text) => mockVector(text, dim)),
    };
  }
  if (config.embeddingProvider === "openai") {
    return {
      dim,
      name: "openai",
      embed: (texts) =>
        embedHttp("https://api.openai.com/v1/embeddings", config.embeddingApiKey, {
          model: "text-embedding-3-small",
          input: texts,
          dimensions: dim,
        }),
    };
  }
  return {
    dim,
    name: "voyage",
    embed: (texts) =>
      embedHttp("https://api.voyageai.com/v1/embeddings", config.embeddingApiKey, {
        model: "voyage-3",
        input: texts,
      }),
  };
}

/** pgvector text literal; the driver has no native vector serializer. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Embed a just-written row in its own transaction (text is already committed,
 * so a failure only leaves `embedding_stale = true`). The update runs as the
 * caller so the row's UPDATE policy still applies.
 */
export async function embedRow(
  db: Db,
  ctx: RlsContext,
  table: "places" | "experiences",
  id: string,
  text: string,
  provider: EmbeddingProvider,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const rows = await provider.embed([trimmed]);
  const vector = rows[0];
  if (!vector) return;
  const literal = toVectorLiteral(vector);
  await withRls(db, ctx, async (tx) => {
    if (table === "places") {
      await tx`
        UPDATE places SET embedding = ${literal}::vector, embedding_stale = false
        WHERE id = ${id}
      `;
    } else {
      await tx`
        UPDATE experiences SET embedding = ${literal}::vector, embedding_stale = false
        WHERE id = ${id}
      `;
    }
  });
}
