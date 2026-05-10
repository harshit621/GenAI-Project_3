# 📓 NotebookLM Clone — RAG-Powered Document Chat

A full-stack **Retrieval-Augmented Generation (RAG)** application that lets you upload any PDF or text document and have an intelligent conversation with it — powered by **Groq LLM** and **Qdrant vector database**.

---

## 🏗 Architecture & RAG Pipeline

```
User uploads file
       │
       ▼
┌──────────────┐
│  1. Parse    │  pdf-parse → extract text per page
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  2. Chunk  (Recursive Character Text Splitter)        │
│     • Tries to split on \n\n → \n → ". " → " "       │
│     • chunkSize = 800 chars, overlap = 150 chars       │
│     • Overlap preserves cross-boundary context         │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  3. Embed  (Xenova/all-MiniLM-L6-v2, local ONNX)     │
│     • 384-dimensional vectors                          │
│     • Runs fully in Node.js — no API key needed        │
│     • Batched (16 at a time) for efficiency            │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────┐
│  4. Store    │  Qdrant — Cosine similarity index
└──────────────┘

         ── At query time ──

User question → embed → similarity search (top 5) → build prompt → Groq LLM → grounded answer
```

---

## 🔑 Chunking Strategy — Recursive Character Text Splitter

Implemented in [`chunker.js`](./chunker.js):

| Step | Separator | Purpose |
|------|-----------|---------|
| 1 | `\n\n` | Preserve paragraph boundaries |
| 2 | `\n` | Line-level fallback |
| 3 | `. ` | Sentence-level fallback |
| 4 | ` ` | Word-level fallback |
| 5 | `""` | Hard character split (last resort) |

**Overlap** (150 chars): each chunk begins with the last 150 characters of the previous chunk, ensuring no context is lost at boundaries.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | Groq `llama-3.1-8b-instant` |
| Embeddings | `@xenova/transformers` · `all-MiniLM-L6-v2` (local, 384-dim) |
| Vector DB | Qdrant (local Docker) |
| Backend | Node.js · Express |
| File Parsing | `pdf-parse` |
| Frontend | Vanilla HTML / CSS / JS |

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- Docker (for Qdrant)
- Groq API key → [console.groq.com](https://console.groq.com)

### 1. Clone & install

```bash
git clone <repo-url>
cd GenAI-Project_3
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — add your GROQ_API_KEY
```

`.env`:
```
GROQ_API_KEY=gsk_...
QDRANT_URL=http://localhost:6333
PORT=3000
```

### 3. Start Qdrant

```bash
docker run -p 6333:6333 qdrant/qdrant
```

### 4. Start the server

```bash
npm start
# or for dev with auto-reload:
npm run dev
```

### 5. Open the app

Navigate to [http://localhost:3000](http://localhost:3000)

---

## 📂 Project Structure

```
GenAI-Project_3/
├── server.js        # Express API server (upload, query, list)
├── rag.js           # RAG pipeline orchestrator
├── chunker.js       # Recursive character text splitter
├── embedder.js      # Local ONNX embedding model
├── vectorStore.js   # Qdrant client interface
├── public/
│   ├── index.html   # Chat UI
│   ├── style.css    # Dark glassmorphism design
│   └── app.js       # Frontend logic
├── .env.example     # Environment template
└── package.json
```

---

## 🎯 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload & index a document |
| `POST` | `/api/query` | Ask a question about a document |
| `GET`  | `/api/documents` | List all indexed documents |
| `GET`  | `/api/health` | Health check |

### POST `/api/upload`
```
Content-Type: multipart/form-data
Body: file (PDF or TXT)

Response: { docId, docName, stats: { pages, chunks, vectorDim } }
```

### POST `/api/query`
```json
{ "question": "What is Node.js?", "docId": "uuid", "topK": 5 }

Response: { "answer": "...", "sources": [{ page, score, snippet }] }
```

---

## 🔒 RAG Grounding Guarantee

The system prompt explicitly forbids the LLM from using general knowledge:

> *"ONLY use information present in the provided context chunks. If the answer is not found in the context, say: 'I couldn't find relevant information in the document.'"*

Temperature is set to `0.2` for maximum factual accuracy.

---

## 📊 Marking Criteria Coverage

| Criterion | Implementation |
|-----------|---------------|
| RAG Pipeline | `rag.js` orchestrates all 4 steps |
| Chunking | Recursive char splitter in `chunker.js` |
| Embedding | Local MiniLM via `@xenova/transformers` |
| Vector DB | Qdrant with cosine similarity |
| Groq LLM | `llama-3.1-8b-instant` with context injection |
| Answer Quality | System prompt enforces document-only answers |
| Web UI | Full chat interface in `public/` |
