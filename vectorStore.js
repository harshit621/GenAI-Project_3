/**
 * vectorStore.js
 * ──────────────────────────────────────────────────────────────────────
 * Dual-mode vector store:
 *
 *  LOCAL  (default)  — JSON file at ./data/vectors.json
 *                      Zero dependencies, perfect for local dev.
 *
 *  CLOUD  (Vercel)   — Qdrant Cloud via REST API
 *                      Set QDRANT_URL + QDRANT_API_KEY in env vars.
 *                      Sign up free at https://cloud.qdrant.io
 *
 * The mode is chosen automatically:
 *   QDRANT_URL set → Qdrant Cloud
 *   otherwise      → local JSON file
 * ──────────────────────────────────────────────────────────────────────
 */

import fs   from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const USE_QDRANT      = !!process.env.QDRANT_URL;
const QDRANT_URL      = process.env.QDRANT_URL      || "";
const QDRANT_API_KEY  = process.env.QDRANT_API_KEY  || "";
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "notebooklm-rag";
export const VECTOR_SIZE = 384;

// ── LOCAL store setup ────────────────────────────────────────────────────
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "vectors.json");
let localStore = { points: [] };
let dirty = false;

// ════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════

export async function ensureCollection() {
  if (USE_QDRANT) {
    await qdrantEnsureCollection();
  } else {
    await localLoad();
    setInterval(async () => { if (dirty) await localSave(); }, 5000);
  }
}

export async function deleteDocumentChunks(docId) {
  if (USE_QDRANT) return qdrantDelete(docId);
  localDelete(docId);
}

export async function upsertChunks(docId, docName, chunks, vectors) {
  if (USE_QDRANT) return qdrantUpsert(docId, docName, chunks, vectors);
  await localUpsert(docId, docName, chunks, vectors);
}

export async function similaritySearch(queryVector, k = 5, docId = null) {
  if (USE_QDRANT) return qdrantSearch(queryVector, k, docId);
  return localSearch(queryVector, k, docId);
}

export async function listDocuments() {
  if (USE_QDRANT) return qdrantListDocs();
  return localListDocs();
}

// ════════════════════════════════════════════════════════════════════════
// LOCAL implementation
// ════════════════════════════════════════════════════════════════════════

async function localLoad() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(STORE_FILE, "utf-8");
    localStore = JSON.parse(raw);
    console.log(`[VectorStore] Loaded ${localStore.points.length} point(s) from disk.`);
  } catch {
    localStore = { points: [] };
    console.log("[VectorStore] Starting with empty local store.");
  }
}

async function localSave() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(localStore), "utf-8");
  dirty = false;
}

function localDelete(docId) {
  const before = localStore.points.length;
  localStore.points = localStore.points.filter(p => p.payload.docId !== docId);
  if (localStore.points.length !== before) dirty = true;
}

async function localUpsert(docId, docName, chunks, vectors) {
  for (let i = 0; i < chunks.length; i++) {
    localStore.points.push({
      id: `${docId}-${i}`,
      vector: vectors[i],
      payload: { docId, docName, text: chunks[i].text, page: chunks[i].metadata.page, chunkIndex: chunks[i].metadata.chunkIndex },
    });
  }
  dirty = true;
  await localSave();
  console.log(`[VectorStore] Stored ${chunks.length} point(s) locally.`);
}

async function localSearch(queryVector, k, docId) {
  let candidates = docId
    ? localStore.points.filter(p => p.payload.docId === docId)
    : localStore.points;
  if (candidates.length === 0) return [];
  const scored = candidates.map(p => ({ payload: p.payload, score: cosine(queryVector, p.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(r => ({ text: r.payload.text, page: r.payload.page, docName: r.payload.docName, score: r.score }));
}

function localListDocs() {
  const seen = new Map();
  for (const p of localStore.points) {
    if (!seen.has(p.payload.docId)) seen.set(p.payload.docId, p.payload.docName);
  }
  return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
}

// ════════════════════════════════════════════════════════════════════════
// QDRANT CLOUD implementation (REST API — no SDK needed)
// ════════════════════════════════════════════════════════════════════════

function qdrantHeaders() {
  const h = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

async function qdrantFetch(path, method = "GET", body = null) {
  const opts = { method, headers: qdrantHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${QDRANT_URL}${path}`, opts);
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`Qdrant ${method} ${path} → ${res.status}: ${txt}`);
  }
  return res.status === 404 ? null : res.json();
}

async function qdrantEnsureCollection() {
  const existing = await qdrantFetch(`/collections/${COLLECTION_NAME}`);
  if (existing) {
    console.log(`[VectorStore] Qdrant collection "${COLLECTION_NAME}" ready.`);
    return;
  }
  await qdrantFetch(`/collections/${COLLECTION_NAME}`, "PUT", {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });
  console.log(`[VectorStore] Qdrant collection "${COLLECTION_NAME}" created.`);
}

async function qdrantDelete(docId) {
  await qdrantFetch(`/collections/${COLLECTION_NAME}/points/delete`, "POST", {
    filter: { must: [{ key: "docId", match: { value: docId } }] },
  });
}

async function qdrantUpsert(docId, docName, chunks, vectors) {
  const points = chunks.map((chunk, i) => ({
    id: hashId(`${docId}-${i}`),
    vector: vectors[i],
    payload: { docId, docName, text: chunk.text, page: chunk.metadata.page, chunkIndex: chunk.metadata.chunkIndex },
  }));
  const BATCH = 100;
  for (let i = 0; i < points.length; i += BATCH) {
    await qdrantFetch(`/collections/${COLLECTION_NAME}/points`, "PUT", {
      wait: true, points: points.slice(i, i + BATCH),
    });
  }
  console.log(`[VectorStore] Qdrant: upserted ${points.length} points.`);
}

async function qdrantSearch(queryVector, k, docId) {
  const body = {
    vector: queryVector, limit: k, with_payload: true,
    ...(docId ? { filter: { must: [{ key: "docId", match: { value: docId } }] } } : {}),
  };
  const res = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/search`, "POST", body);
  return (res?.result || []).map(r => ({
    text: r.payload.text, page: r.payload.page, docName: r.payload.docName, score: r.score,
  }));
}

async function qdrantListDocs() {
  const seen = new Map();
  let offset = null;
  do {
    const body = { limit: 250, with_payload: ["docId", "docName"], with_vector: false };
    if (offset != null) body.offset = offset;
    const res = await qdrantFetch(`/collections/${COLLECTION_NAME}/points/scroll`, "POST", body);
    if (!res?.result) break;
    for (const p of res.result.points) {
      if (!seen.has(p.payload.docId)) seen.set(p.payload.docId, p.payload.docName);
    }
    offset = res.result.next_page_offset;
  } while (offset != null);
  return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i]; }
  const d = Math.sqrt(magA) * Math.sqrt(magB);
  return d === 0 ? 0 : dot / d;
}

function hashId(str) {
  let h1 = 0x9dc5811c, h2 = 0x1b873593;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  h1 = (Math.imul(h1 ^ (h1>>>16), 2246822519) ^ Math.imul(h2 ^ (h2>>>13), 3266489917)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2>>>16), 2246822519) ^ Math.imul(h1 ^ (h1>>>13), 3266489917)) >>> 0;
  const hex = (h1 * 4294967296 + h2).toString(16).padStart(16, "0");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20)}${"0".repeat(12)}`.slice(0, 36);
}
