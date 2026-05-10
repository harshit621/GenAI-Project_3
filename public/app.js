/**
 * app.js — NotebookLM RAG Chat Frontend
 * Handles: file upload, document selection, chat, sources modal
 */

// ── State ────────────────────────────────────────────────────────────────
const state = {
  activeDocId:   null,
  activeDocName: null,
  documents:     [],
  isQuerying:    false,
};

// ── DOM refs ─────────────────────────────────────────────────────────────
const uploadZone    = document.getElementById("uploadZone");
const fileInput     = document.getElementById("fileInput");
const browseBtn     = document.getElementById("browseBtn");
const uploadProgress= document.getElementById("uploadProgress");
const progressFill  = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const docList       = document.getElementById("docList");
const messages      = document.getElementById("messages");
const welcomeState  = document.getElementById("welcomeState");
const queryInput    = document.getElementById("queryInput");
const sendBtn       = document.getElementById("sendBtn");
const activeDocName = document.getElementById("activeDocName");
const clearBtn      = document.getElementById("clearBtn");
const menuBtn       = document.getElementById("menuBtn");
const sidebar       = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const sourcesModal  = document.getElementById("sourcesModal");
const sourcesBody   = document.getElementById("sourcesBody");
const closeModal    = document.getElementById("closeModal");

// ── Init ─────────────────────────────────────────────────────────────────
(async function init() {
  await loadDocuments();
  setupUpload();
  setupChat();
  setupSidebar();
  setupModal();
})();

// ════════════════════════════════════════════════════════════════════════
// Documents
// ════════════════════════════════════════════════════════════════════════

async function loadDocuments() {
  try {
    const res = await fetch("/api/documents");
    const data = await res.json();
    state.documents = data.documents || [];
    renderDocList();
  } catch {
    // Qdrant might not be running yet — silently ignore
  }
}

function renderDocList() {
  docList.innerHTML = "";
  if (state.documents.length === 0) {
    docList.innerHTML = '<li class="doc-empty">No documents yet</li>';
    return;
  }
  for (const doc of state.documents) {
    const li = document.createElement("li");
    li.className = "doc-item" + (doc.id === state.activeDocId ? " active" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", doc.id === state.activeDocId);
    li.setAttribute("data-id", doc.id);
    li.setAttribute("tabindex", "0");
    li.innerHTML = `
      <span class="doc-item-icon">📄</span>
      <div class="doc-item-info">
        <div class="doc-item-name" title="${escHtml(doc.name)}">${escHtml(doc.name)}</div>
        <div class="doc-item-meta">Click to chat</div>
      </div>`;
    li.addEventListener("click", () => selectDocument(doc.id, doc.name));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") selectDocument(doc.id, doc.name);
    });
    docList.appendChild(li);
  }
}

function selectDocument(docId, docName) {
  state.activeDocId   = docId;
  state.activeDocName = docName;

  // Update UI
  activeDocName.textContent = docName;
  queryInput.disabled = false;
  sendBtn.disabled    = false;
  queryInput.placeholder = `Ask anything about "${docName}"…`;

  // Update list highlight
  renderDocList();

  // Clear chat
  clearConversation();

  // On mobile: close sidebar
  if (window.innerWidth <= 640) sidebar.classList.add("collapsed");
}

// ════════════════════════════════════════════════════════════════════════
// Upload
// ════════════════════════════════════════════════════════════════════════

function setupUpload() {
  browseBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener("click", () => fileInput.click());
  uploadZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFileUpload(fileInput.files[0]); });

  // Drag & drop
  uploadZone.addEventListener("dragover",  (e) => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
  uploadZone.addEventListener("dragleave", ()  => uploadZone.classList.remove("drag-over"));
  uploadZone.addEventListener("drop",      (e) => {
    e.preventDefault();
    uploadZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  });
}

async function handleFileUpload(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["pdf", "txt"].includes(ext)) {
    showToast("⚠️ Only PDF and TXT files are supported.", "error");
    return;
  }

  // Show progress
  uploadZone.classList.add("hidden");
  uploadProgress.classList.remove("hidden");
  setProgress(10, `Uploading "${file.name}"…`);

  try {
    const formData = new FormData();
    formData.append("file", file);

    setProgress(25, "Uploading…");
    const res = await fetch("/api/upload", { method: "POST", body: formData });

    setProgress(60, "Chunking & embedding…");
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Upload failed.");

    setProgress(100, "Done! ✅");
    await sleep(800);

    showToast(`✅ "${file.name}" indexed — ${data.stats.chunks} chunks`, "success");

    // Add to local list and select
    const newDoc = { id: data.docId, name: data.docName };
    state.documents.unshift(newDoc);
    selectDocument(newDoc.id, newDoc.name);

  } catch (err) {
    showToast(`❌ ${err.message}`, "error");
  } finally {
    uploadProgress.classList.add("hidden");
    uploadZone.classList.remove("hidden");
    setProgress(0, "");
    fileInput.value = "";
  }
}

function setProgress(pct, label) {
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = label;
}

// ════════════════════════════════════════════════════════════════════════
// Chat
// ════════════════════════════════════════════════════════════════════════

function setupChat() {
  sendBtn.addEventListener("click", submitQuery);
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitQuery(); }
  });

  // Auto-resize textarea
  queryInput.addEventListener("input", () => {
    queryInput.style.height = "auto";
    queryInput.style.height = Math.min(queryInput.scrollHeight, 160) + "px";
  });

  clearBtn.addEventListener("click", clearConversation);
}

async function submitQuery() {
  const question = queryInput.value.trim();
  if (!question || state.isQuerying || !state.activeDocId) return;

  state.isQuerying = true;
  sendBtn.disabled = true;

  // Hide welcome, show question
  welcomeState?.remove();
  appendMessage("user", question);
  queryInput.value = "";
  queryInput.style.height = "auto";

  // Show typing
  const typingEl = appendTyping();

  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, docId: state.activeDocId, topK: 5 }),
    });
    const data = await res.json();
    typingEl.remove();

    if (!res.ok) throw new Error(data.error || "Query failed.");

    appendMessage("ai", data.answer, data.sources);
  } catch (err) {
    typingEl.remove();
    appendMessage("ai", `❌ Error: ${err.message}`);
  } finally {
    state.isQuerying = false;
    sendBtn.disabled = !state.activeDocId;
    queryInput.focus();
    scrollToBottom();
  }
}

function appendMessage(role, text, sources = null) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "👤" : "🤖";

  const body = document.createElement("div");
  body.className = "msg-body";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = formatText(text);

  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(time);

  if (sources && sources.length > 0) {
    const srcBtn = document.createElement("button");
    srcBtn.className = "sources-btn";
    srcBtn.textContent = `${sources.length} source${sources.length > 1 ? "s" : ""}`;
    srcBtn.addEventListener("click", () => showSources(sources));
    meta.appendChild(srcBtn);
  }

  body.appendChild(bubble);
  body.appendChild(meta);
  msg.appendChild(avatar);
  msg.appendChild(body);
  messages.appendChild(msg);

  scrollToBottom();
  return msg;
}

function appendTyping() {
  const msg = document.createElement("div");
  msg.className = "message ai typing-indicator";
  msg.innerHTML = `
    <div class="msg-avatar">🤖</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>`;
  messages.appendChild(msg);
  scrollToBottom();
  return msg;
}

function clearConversation() {
  // Remove all messages except the welcome state placeholder
  [...messages.children].forEach(el => {
    if (!el.classList.contains("welcome-state")) el.remove();
  });

  // Re-insert welcome if no doc selected
  if (!state.activeDocId && !welcomeState.parentElement) {
    messages.appendChild(welcomeState);
    welcomeState.classList.remove("hidden");
  }
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ════════════════════════════════════════════════════════════════════════
// Sources Modal
// ════════════════════════════════════════════════════════════════════════

function setupModal() {
  closeModal.addEventListener("click", () => sourcesModal.classList.add("hidden"));
  sourcesModal.addEventListener("click", (e) => {
    if (e.target === sourcesModal) sourcesModal.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") sourcesModal.classList.add("hidden");
  });
}

function showSources(sources) {
  sourcesBody.innerHTML = "";
  sources.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "source-card";
    card.innerHTML = `
      <div class="source-header">
        <span class="source-page">📄 Page ${s.page ?? "?"}</span>
        <span class="source-score">Relevance: ${(s.score * 100).toFixed(1)}%</span>
      </div>
      <div class="source-snippet">${escHtml(s.snippet)}</div>`;
    sourcesBody.appendChild(card);
  });
  sourcesModal.classList.remove("hidden");
}

// ════════════════════════════════════════════════════════════════════════
// Sidebar toggle (mobile)
// ════════════════════════════════════════════════════════════════════════

function setupSidebar() {
  menuBtn.addEventListener("click",       () => sidebar.classList.toggle("collapsed"));
  sidebarToggle.addEventListener("click", () => sidebar.classList.add("collapsed"));
}

// ════════════════════════════════════════════════════════════════════════
// Toast notification
// ════════════════════════════════════════════════════════════════════════

function showToast(message, type = "info") {
  // Remove existing toasts
  document.querySelectorAll(".toast").forEach(t => t.remove());

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 200;
    background: ${type === "error" ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)"};
    border: 1px solid ${type === "error" ? "rgba(239,68,68,0.4)" : "rgba(16,185,129,0.4)"};
    color: ${type === "error" ? "#fca5a5" : "#6ee7b7"};
    padding: 12px 20px; border-radius: 12px; font-size: 13px;
    backdrop-filter: blur(10px); max-width: 320px;
    animation: slide-up 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Very lightweight markdown-ish formatter */
function formatText(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br />");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
