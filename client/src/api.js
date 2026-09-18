const json = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || `${r.status} ${r.statusText}`);
    err.status = r.status;
    throw err;
  }
  return body;
};

// The session lives in an httpOnly cookie, so every call must opt in to
// sending it — fetch omits cookies cross-origin by default, and the Vite dev
// server counts as a different origin from the API.
const send = (url, opts = {}) =>
  fetch(url, {
    credentials: "include",
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
  }).then(json);

const post = (url, body) => send(url, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  // --- auth ---
  me: () => send("/api/auth/me"),
  login: (email, password) => post("/api/auth/login", { email, password }),
  logout: () => post("/api/auth/logout"),
  changePassword: (currentPassword, newPassword) => post("/api/auth/password", { currentPassword, newPassword }),
  users: () => send("/api/auth/users"),
  createUser: (body) => post("/api/auth/users", body),
  updateUser: (id, body) => send(`/api/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  activity: () => send("/api/admin/activity"),

  // --- tenders ---
  categories: () => send("/api/tenders/meta/categories"),
  models: () => send("/api/tenders/meta/models"),
  list: () => send("/api/tenders"),
  get: (id) => send(`/api/tenders/${id}`),
  clauses: (id, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return send(`/api/tenders/${id}/clauses${q ? `?${q}` : ""}`);
  },
  page: (id, page, file) => send(`/api/tenders/${id}/pages/${page}${file ? `?file=${encodeURIComponent(file)}` : ""}`),
  upload: (form) => fetch("/api/tenders", { method: "POST", body: form, credentials: "include" }).then(json),
  resegregate: (id, body) => post(`/api/tenders/${id}/segregate`, body),
  remove: (id) => send(`/api/tenders/${id}`, { method: "DELETE" }),
  refreshOverview: (id, body = {}) => post(`/api/tenders/${id}/overview`, body),
  execSummary: (id, body = {}) => post(`/api/tenders/${id}/executive-summary`, body),
  updateClause: (id, clauseId, body) => send(`/api/tenders/${id}/clauses/${clauseId}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeClause: (id, clauseId) => send(`/api/tenders/${id}/clauses/${clauseId}`, { method: "DELETE" }),
  removeExecPoint: (id, category, pointIndex) =>
    send(`/api/tenders/${id}/executive-summary/${category}/${pointIndex}`, { method: "DELETE" }),
  questions: () => send("/api/tenders/meta/questions"),
  removeQuestion: (qid) => send(`/api/tenders/meta/questions/${qid}`, { method: "DELETE" }),
  chat: (id, body) => post(`/api/tenders/${id}/chat`, body),

  // --- notes (private per user; super admins can read others') ---
  notes: (id, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return send(`/api/tenders/${id}/notes${q ? `?${q}` : ""}`);
  },
  addNote: (id, body) => post(`/api/tenders/${id}/notes`, body),
  updateNote: (id, noteId, body) => send(`/api/tenders/${id}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeNote: (id, noteId) => send(`/api/tenders/${id}/notes/${noteId}`, { method: "DELETE" }),

  // --- chat history ---
  chatHistory: (id, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return send(`/api/tenders/${id}/chat-history${q ? `?${q}` : ""}`);
  },
  clearChatHistory: (id) => send(`/api/tenders/${id}/chat-history`, { method: "DELETE" }),
};
