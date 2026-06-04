const BASE = "/api";

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const json = (body: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const api = {
  health: () => req("/health"),
  getSettings: () => req("/settings"),
  putSettings: (data: Record<string, unknown>) =>
    req("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }),

  createSession: (device?: string) => req("/sessions", json({ device: device ?? navigator.userAgent })),
  listSessions: () => req("/sessions"),
  closeSession: (sid: number) => req(`/sessions/${sid}/close`, { method: "POST" }),
  processSession: (sid: number) => req(`/sessions/${sid}/process`, { method: "POST" }),
  sessionTurns: (sid: number) => req(`/sessions/${sid}/turns`),
  ingestWindow: (sid: number, blob: Blob, index: number, filename = "window.webm") => {
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("window_index", String(index));
    return req(`/sessions/${sid}/windows`, { method: "POST", body: fd });
  },

  listPeople: () => req("/people"),
  enroll: (fd: FormData) => req("/people/enroll", { method: "POST", body: fd }),
  relabel: (sid: number, label: string, body: Record<string, unknown>) =>
    req(`/sessions/${sid}/speakers/${encodeURIComponent(label)}`, json(body)),
  deletePerson: (pid: number) => req(`/people/${pid}`, { method: "DELETE" }),

  listConversations: () => req("/conversations"),
  conversation: (cid: number) => req(`/conversations/${cid}`),
  graph: (entityId?: number, hops = 2) =>
    req(`/graph${entityId ? `?entity_id=${entityId}&hops=${hops}` : ""}`),
  entities: () => req("/entities"),

  search: (q: string, topN?: number) => req("/search", json({ q, top_n: topN })),
  chat: (message: string, history: { role: string; content: string }[] = []) =>
    req("/chat", json({ message, history })),

  actionItems: (status?: string) => req(`/action_items${status ? `?status=${status}` : ""}`),
  updateAction: (id: number, status: string) =>
    req(`/action_items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }),
  draftAction: (id: number) => req(`/action_items/${id}/draft`, { method: "POST" }),

  runRecap: (day?: string) => req("/recap/run", json(day ? { day } : {})),
  rollups: () => req("/rollups"),
};
