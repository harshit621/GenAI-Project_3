/**
 * rag.js
 * ──────────────────────────────────────────────────────────────────────
 * Core RAG Pipeline Orchestrator
 *
 * Ingestion  (indexDocument)  → parse → chunk → embed → store
 * Retrieval  (queryDocument)  → embed query → search → build prompt → LLM
 * ──────────────────────────────────────────────────────────────────────
 */

import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import Groq from "groq-sdk";

import { chunkDocuments } from "./chunker.js";
import { embedText, embedBatch } from "./embedder.js";
import {
  ensureCollection,
  upsertChunks,
  deleteDocumentChunks,
  similaritySearch,
} from "./vectorStore.js";

// ── Groq client ──────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Collection bootstrap ─────────────────────────────────────────────────
let collectionReady = false;
export async function initVectorStore() {
  if (!collectionReady) {
    await ensureCollection();
    collectionReady = true;
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. INGESTION
// ════════════════════════════════════════════════════════════════════════

/**
 * Parse a file (PDF or TXT) into an array of { text, page } objects.
 */
async function parseFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf" || mimeType === "application/pdf") {
    const buffer = await fs.readFile(filePath);
    const parsed = await pdfParse(buffer);

    // pdfParse doesn't give per-page text easily; split on form-feed char
    const rawPages = parsed.text.split("\f");
    return rawPages.map((text, i) => ({
      text: text.trim(),
      page: i + 1,
    })).filter(p => p.text.length > 0);
  }

  // Plain text — treat entire file as page 1
  const text = await fs.readFile(filePath, "utf-8");
  return [{ text: text.trim(), page: 1 }];
}

/**
 * Full ingestion pipeline: parse → chunk → embed → store
 *
 * @param {string} filePath  - path to uploaded file
 * @param {string} docId     - unique document ID (UUID)
 * @param {string} docName   - original filename
 * @param {string} mimeType  - MIME type from multer
 * @returns {object}         - stats about ingestion
 */
export async function indexDocument(filePath, docId, docName, mimeType) {
  await initVectorStore();

  console.log(`\n[RAG] ── Ingestion started for "${docName}" ──`);

  // Step 1: Parse
  console.log("[RAG] Step 1/4 → Parsing document…");
  const pages = await parseFile(filePath, mimeType);
  console.log(`[RAG]   → ${pages.length} page(s) extracted.`);

  // Step 2: Chunk
  console.log("[RAG] Step 2/4 → Chunking (recursive char splitter, size=800, overlap=150)…");
  const chunks = chunkDocuments(pages, 800, 150);
  console.log(`[RAG]   → ${chunks.length} chunk(s) created.`);

  // Step 3: Embed
  console.log("[RAG] Step 3/4 → Embedding chunks…");
  const texts = chunks.map(c => c.text);
  const vectors = await embedBatch(texts, 16);
  console.log(`[RAG]   → ${vectors.length} vector(s) generated.`);

  // Step 4: Store (delete old if re-upload)
  console.log("[RAG] Step 4/4 → Storing in Qdrant…");
  await deleteDocumentChunks(docId);
  await upsertChunks(docId, docName, chunks, vectors);

  console.log(`[RAG] ── Ingestion complete for "${docName}" ──\n`);

  return {
    pages: pages.length,
    chunks: chunks.length,
    vectorDim: vectors[0]?.length ?? 0,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 2. RETRIEVAL + GENERATION
// ════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a precise document assistant. Your ONLY job is to answer the user's question using the retrieved context chunks from their uploaded document.

Rules:
1. ONLY use information present in the provided context chunks.
2. If the answer is not found in the context, say: "I couldn't find relevant information in the document for this question."
3. Cite the page number when available (e.g., "According to page 3…").
4. Do NOT use your general training knowledge to fill in gaps.
5. Be concise, accurate, and helpful.`;

/**
 * Retrieve relevant chunks and generate a grounded answer via Groq.
 *
 * @param {string} userQuery   - user's natural language question
 * @param {string} docId       - restrict retrieval to this document
 * @param {number} topK        - number of chunks to retrieve (default 5)
 * @returns {object}           - { answer, sources }
 */
export async function queryDocument(userQuery, docId, topK = 5) {
  console.log(`\n[RAG] ── Query: "${userQuery}" ──`);

  // Embed the user query
  console.log("[RAG] Embedding query…");
  const queryVector = await embedText(userQuery);

  // Retrieve top-k similar chunks
  console.log(`[RAG] Searching vector store (top ${topK})…`);
  const chunks = await similaritySearch(queryVector, topK, docId);
  console.log(`[RAG] Retrieved ${chunks.length} chunk(s).`);

  if (chunks.length === 0) {
    return {
      answer: "No relevant content found in the document. Please make sure the document was indexed correctly.",
      sources: [],
    };
  }

  // Build context string
  const contextText = chunks
    .map((c, i) => `[Chunk ${i + 1} | Page ${c.page} | Relevance: ${(c.score * 100).toFixed(1)}%]\n${c.text}`)
    .join("\n\n---\n\n");

  // Generate answer with Groq
  console.log("[RAG] Generating answer with Groq (llama-3.1-8b-instant)…");
  const response = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here are the relevant excerpts from the document:\n\n${contextText}\n\n---\n\nQuestion: ${userQuery}`,
      },
    ],
    temperature: 0.2,      // low temperature for factual accuracy
    max_tokens: 1024,
  });

  const answer = response.choices[0].message.content;

  // Return sources for citation display
  const sources = chunks.map((c) => ({
    page: c.page,
    score: c.score,
    snippet: c.text.slice(0, 200) + (c.text.length > 200 ? "…" : ""),
  }));

  console.log("[RAG] Answer generated.\n");
  return { answer, sources };
}
