import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { NoteForm } from "./NotesPanel.jsx";

// Splits a reply on "[filename p26]" citation tags and turns each into a
// clickable chip that opens the source page — same tag format the model was
// told to use verbatim in chatPrompt() (services/prompts.js). Tolerates the
// model occasionally combining pages in one bracket ("[file.pdf p57, p58]")
// even though the prompt asks it not to — one chip per page number found.
const CITE_RE = /\[([^\[\]]+?)\s+p(\d+(?:\s*,\s*p?\d+)*)\]/g;

/**
 * Inline formatting for one line: **bold**, `code`, and the [file p#]
 * citation tags the model is told to emit (rendered as clickable chips that
 * open the real PDF page). Deliberately hand-rolled — the model only ever
 * emits a handful of markdown constructs, so this avoids shipping a parser
 * plus a sanitiser just to render bold text.
 */
function renderInline(text, onOpenPage, keyBase) {
  const out = [];
  let k = 0;
  // Split on citations first, so their contents are never re-parsed as markdown.
  let last = 0;
  let m;
  CITE_RE.lastIndex = 0;
  const chunks = [];
  while ((m = CITE_RE.exec(text))) {
    if (m.index > last) chunks.push({ t: "text", v: text.slice(last, m.index) });
    const file = m[1];
    m[2].split(",").map((x) => parseInt(x.replace(/[^\d]/g, ""), 10)).filter(Number.isFinite)
      .forEach((page) => chunks.push({ t: "cite", file, page }));
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push({ t: "text", v: text.slice(last) });

  for (const c of chunks) {
    if (c.t === "cite") {
      out.push(
        <button key={keyBase + "-c" + k++} className="link small cite-chip" onClick={() => onOpenPage(c.page, c.file)}>
          {c.file} p{c.page}
        </button>
      );
      continue;
    }
    const parts = c.v.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("**") && part.endsWith("**")) out.push(<strong key={keyBase + "-b" + k++}>{part.slice(2, -2)}</strong>);
      else if (part.startsWith("`") && part.endsWith("`")) out.push(<code key={keyBase + "-m" + k++}>{part.slice(1, -1)}</code>);
      else out.push(<span key={keyBase + "-t" + k++}>{part}</span>);
    }
  }
  return out;
}

/** Block level: headings, bullet and numbered lists, paragraphs. */
function renderReply(text, onOpenPage) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let list = null;

  const flush = () => {
    if (!list) return;
    const items = list.items;
    const key = "l" + blocks.length;
    blocks.push(
      list.ordered ? (
        <ol key={key} className="chat-list">{items.map((it, i) => <li key={i}>{renderInline(it, onOpenPage, key + "i" + i)}</li>)}</ol>
      ) : (
        <ul key={key} className="chat-list">{items.map((it, i) => <li key={i}>{renderInline(it, onOpenPage, key + "i" + i)}</li>)}</ul>
      )
    );
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); return; }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (bullet) {
      if (list && list.ordered) flush();
      list = list || { ordered: false, items: [] };
      list.items.push(bullet[1]);
    } else if (numbered) {
      if (list && !list.ordered) flush();
      list = list || { ordered: true, items: [] };
      list.items.push(numbered[2]);
    } else if (heading) {
      flush();
      blocks.push(<h5 key={"h" + i} className="chat-h">{renderInline(heading[1], onOpenPage, "h" + i)}</h5>);
    } else {
      flush();
      blocks.push(<p key={"p" + i} className="chat-p">{renderInline(line, onOpenPage, "p" + i)}</p>);
    }
  });
  flush();
  return blocks;
}

const STARTERS = [
  "What's the EMD amount and how can it be submitted?",
  "Are there any conflicting clauses I should know about?",
  "What are the eligibility / qualification criteria?",
  "What are the key deadlines for this tender?",
];

// Models offered for chat. Deliberately a short curated list rather than
// OpenRouter's full catalogue: the full list needs an admin-only endpoint,
// runs to hundreds of entries, and most of them either lack JSON-schema
// support or have too small a context window to hold this tender's clauses.
// Every entry below was checked against the live OpenRouter model list for
// JSON-schema support and a 1M-token context. Prices are per million tokens
// (input/output) at time of writing — verify on openrouter.ai before relying
// on them. "" = use whatever model this tender was analysed with.
const CHAT_MODELS = [
  { id: "", label: "Default (same model as the analysis)" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash — newest ($0.15/$0.60)" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash — balanced ($0.09/$0.18)" },
  { id: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash 0731 — cheapest in ($0.04/$0.64)" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro — highest quality ($0.96/$1.91)" },
];

export default function ChatPanel({ tenderId, provider, model, hasExecSummary, onOpenPage, onNoted }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [addingIdx, setAddingIdx] = useState(-1);
  const [maximized, setMaximized] = useState(false);
  // "" means fall back to the tender's own model, which is what the server
  // does when no model is supplied.
  const [chatModel, setChatModel] = useState("");
  const bottomRef = useRef(null);

  // Chat history is stored server-side now, so a reload (or a colleague's
  // machine, for a super admin) shows the conversation instead of a blank
  // panel — and a question already answered need not be re-asked at ~35k
  // tokens a turn.
  useEffect(() => {
    api.chatHistory(tenderId)
      .then((rows) => setMessages(rows.map((r) => ({
        role: r.role,
        text: r.text,
        category: r.category,
        searchedFullDocument: r.searchedFullDocument,
      }))))
      // Surfaced rather than swallowed: silently failing here looks identical
      // to "you have no history", which is exactly the wrong impression if
      // the request actually errored.
      .catch((e) => setError(`Couldn't load earlier messages: ${e.message}`));
  }, [tenderId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    setError("");
    setInput("");
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const { reply, category, searchedFullDocument } = await api.chat(tenderId, {
        message: q,
        history,
        provider: chatModel ? "openrouter" : provider, // every curated model is an OpenRouter id
        model: chatModel || model,
      });
      setMessages((m) => [...m, { role: "assistant", text: reply, category, question: q, searchedFullDocument }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`card chat-panel no-print ${open ? "open" : "collapsed"} ${open && maximized ? "maximized" : ""}`}>
      <div className="chat-header">
        <button className="chat-toggle" onClick={() => setOpen((o) => !o)}>
          💬 <span className="label">Ask about this tender</span> {open ? "▾" : "▸"}
          {!open && messages.length > 0 && <span className="count">{messages.length}</span>}
        </button>
        {open && (
          <button
            className="chat-size"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore chat" : "Maximize chat"}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? "🗗" : "🗖"}
          </button>
        )}
      </div>
      {open && (
        <div className="chat-body">
          <div className="chat-log">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p className="muted small">
                  Ask a question about this tender. Every answer includes a citation you can click to view the exact source page.
                </p>
                <div className="chat-starters">
                  {STARTERS.map((s) => (
                    <button key={s} className="chip-btn" onClick={() => send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <span className="who">{m.role === "user" ? "You" : "Analyst"}</span>
                <div className="bubble">{m.role === "assistant" ? renderReply(m.text, onOpenPage) : m.text}</div>
                {m.role === "assistant" && (
                  m.searchedFullDocument ? (
                    <span
                      className="src-note gap"
                      title="This answer required reviewing the full document directly. Consider saving it to your notes so it's readily available next time."
                    >
                      ⚠ Required a deeper document review
                    </span>
                  ) : (
                    <span className="src-note ok" title="This answer is based on details already identified in this tender.">
                      ✓ Verified answer
                    </span>
                  )
                )}
                {m.role === "assistant" && (
                  addingIdx === i ? (
                    <NoteForm
                      tenderId={tenderId}
                      allowExecSummary={hasExecSummary}
                      preset={{
                        title: (m.question || "").slice(0, 80),
                        text: m.text,
                        category: m.category || "",
                        source: "chat",
                        askedQuestion: m.question || "",
                      }}
                      onDone={(out) => { setAddingIdx(-1); onNoted?.(out); }}
                      onCancel={() => setAddingIdx(-1)}
                    />
                  ) : (
                    <button className={m.searchedFullDocument ? "link small add-btn urge" : "link small add-btn"} onClick={() => setAddingIdx(i)}>
                      + Save to my notes
                    </button>
                  )
                )}
              </div>
            ))}
            {loading && (
              <div className="chat-msg assistant">
                <span className="who">Analyst</span>
                <div className="bubble muted">Thinking…</div>
              </div>
            )}
            {error && <p className="error small">⚠ {error}</p>}
            <div ref={bottomRef} />
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => { e.preventDefault(); send(); }}
          >
            <input
              placeholder="Ask a question about this tender…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />
            <button type="submit" disabled={loading || !input.trim()}>Send</button>
          </form>
          <label className="chat-model">
            <span className="muted">Model</span>
            <select value={chatModel} onChange={(e) => setChatModel(e.target.value)} disabled={loading}>
              {CHAT_MODELS.map((m) => <option key={m.id || "default"} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>
      )}
    </section>
  );
}
