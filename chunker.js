/**
 * chunker.js
 * ──────────────────────────────────────────────────────────────────────
 * Chunking Strategy: Recursive Character Text Splitter
 *
 * How it works:
 *  1. Try to split on double-newlines (paragraph boundaries) first.
 *  2. If a chunk is still too large, fall back to single newlines.
 *  3. If still too large, fall back to sentences (". ").
 *  4. As a last resort, hard-split by character count.
 *
 * Each chunk carries metadata: { pageNumber, chunkIndex, charStart, charEnd }
 *
 * Parameters:
 *  - chunkSize   : max characters per chunk (default 800)
 *  - chunkOverlap: overlap characters between chunks (default 150)
 *    Overlap ensures that context crossing chunk boundaries is not lost.
 * ──────────────────────────────────────────────────────────────────────
 */

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Split text recursively using the first separator that yields
 * chunks smaller than `maxSize`.
 */
function recursiveSplit(text, separators, maxSize) {
  if (text.length <= maxSize) return [text];
  if (separators.length === 0) {
    // Hard split at maxSize
    const parts = [];
    for (let i = 0; i < text.length; i += maxSize) {
      parts.push(text.slice(i, i + maxSize));
    }
    return parts;
  }

  const [sep, ...rest] = separators;
  const segments = sep ? text.split(sep) : [text];

  const chunks = [];
  let current = "";

  for (const seg of segments) {
    const candidate = current ? current + sep + seg : seg;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      // If this single segment is still too big, recurse
      if (seg.length > maxSize) {
        chunks.push(...recursiveSplit(seg, rest, maxSize));
        current = "";
      } else {
        current = seg;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Main chunking function
 * @param {Array<{text: string, page: number}>} pages  - extracted pages
 * @param {number} chunkSize    - max chars per chunk
 * @param {number} chunkOverlap - overlap chars
 * @returns {Array<{text: string, metadata: object}>}
 */
export function chunkDocuments(pages, chunkSize = 800, chunkOverlap = 150) {
  const allChunks = [];
  let chunkIndex = 0;

  for (const { text, page } of pages) {
    const rawChunks = recursiveSplit(text, SEPARATORS, chunkSize);

    for (let i = 0; i < rawChunks.length; i++) {
      let chunkText = rawChunks[i];

      // Add overlap from previous chunk's tail
      if (i > 0 && chunkOverlap > 0) {
        const prev = rawChunks[i - 1];
        const overlap = prev.slice(Math.max(0, prev.length - chunkOverlap));
        chunkText = overlap + " " + chunkText;
      }

      if (!chunkText.trim()) continue;

      allChunks.push({
        text: chunkText.trim(),
        metadata: {
          page,
          chunkIndex,
          chunkLength: chunkText.trim().length,
        },
      });
      chunkIndex++;
    }
  }

  return allChunks;
}
