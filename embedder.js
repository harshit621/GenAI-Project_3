/**
 * embedder.js — HuggingFace Inference API embeddings
 * ──────────────────────────────────────────────────────────────────────
 * Uses HuggingFace's free Inference API with the
 * "sentence-transformers/all-MiniLM-L6-v2" model (384-dim vectors).
 *
 * No local model download, no native binaries, works everywhere.
 * Free tier: ~1000 requests/day (enough for normal use).
 *
 * Set HF_API_KEY in .env for higher rate limits, or leave blank to use
 * the anonymous free tier.
 * ──────────────────────────────────────────────────────────────────────
 */

const HF_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const HF_URL   = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`;

/** Dimensionality of all-MiniLM-L6-v2 */
export const VECTOR_SIZE = 384;

/**
 * Embed a single text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  const results = await hfEmbed([text]);
  return results[0];
}

/**
 * Embed an array of texts in batches of 32.
 * @param {string[]} texts
 * @param {number}   batchSize
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, batchSize = 32) {
  const all = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vecs  = await hfEmbed(batch);
    all.push(...vecs);
    console.log(`[Embedder] Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks…`);
  }
  return all;
}

// ── Internal ─────────────────────────────────────────────────────────────

async function hfEmbed(texts) {
  const headers = { "Content-Type": "application/json" };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(HF_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HF API ${res.status}: ${err}`);
      }

      const data = await res.json();

      // Response is either [ [vec], [vec], … ] or [ float, float, … ] (single)
      if (typeof data[0] === "number") return [data];   // single text
      return data;                                       // array of vecs

    } catch (err) {
      lastErr = err;
      console.warn(`[Embedder] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
