/**
 * server.js
 * ──────────────────────────────────────────────────────────────────────
 * Express REST API + static file server
 *
 * Endpoints:
 *   POST /api/upload      - upload & index a document
 *   POST /api/query       - query an indexed document
 *   GET  /api/documents   - list all indexed documents
 *   GET  /api/health      - health check
 * ──────────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";

import { indexDocument, queryDocument, initVectorStore } from "./rag.js";
import { listDocuments } from "./vectorStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;

// ── Express setup ────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Multer (file upload) ─────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "uploads");
await fs.mkdir(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    // Safe unique filename
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".txt"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error("Only PDF and plain-text files are supported."));
  },
});

// ════════════════════════════════════════════════════════════════════════
// Routes
// ════════════════════════════════════════════════════════════════════════

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// List all indexed documents
app.get("/api/documents", async (req, res) => {
  try {
    const docs = await listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    console.error("[Server] listDocuments error:", err);
    res.status(500).json({ error: "Failed to list documents." });
  }
});

// Upload & index a document
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const docId   = uuidv4();
  const docName = req.file.originalname;
  const filePath = req.file.path;

  try {
    const stats = await indexDocument(filePath, docId, docName, req.file.mimetype);

    // Clean up temp file
    await fs.unlink(filePath).catch(() => {});

    res.json({
      success: true,
      docId,
      docName,
      stats,
      message: `"${docName}" indexed successfully — ${stats.chunks} chunks, ${stats.pages} pages.`,
    });
  } catch (err) {
    console.error("[Server] indexDocument error:", err);
    await fs.unlink(filePath).catch(() => {});
    res.status(500).json({ error: `Indexing failed: ${err.message}` });
  }
});

// Query a document
app.post("/api/query", async (req, res) => {
  const { question, docId, topK = 5 } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: "question is required." });
  }
  if (!docId) {
    return res.status(400).json({ error: "docId is required." });
  }

  try {
    const result = await queryDocument(question.trim(), docId, Number(topK));
    res.json(result);
  } catch (err) {
    console.error("[Server] queryDocument error:", err);
    res.status(500).json({ error: `Query failed: ${err.message}` });
  }
});

// ════════════════════════════════════════════════════════════════════════
// Start server
// ════════════════════════════════════════════════════════════════════════
console.log("[Server] Initialising local vector store…");
try {
  await initVectorStore();
  console.log("[Server] Local vector store ready (data/vectors.json).");
} catch (err) {
  console.error("[Server] WARNING: Could not initialise vector store:", err.message);
}

const server = app.listen(PORT, () => {
  console.log(`\n🚀  NotebookLM RAG server running at http://localhost:${PORT}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌  Port ${PORT} is already in use.`);
    console.error(`   Run this to free it (PowerShell):`);
    console.error(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
