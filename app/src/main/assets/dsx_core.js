/* ============================================================================
 * shared.js — 纯函数：会话归一化、TXT / HTML 渲染（浏览器与 Node 测试共用）。
 * 浏览器挂 window.DSExp；Node 走 module.exports。
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DSExp = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function pad(n) { return String(n).padStart(2, "0"); }

  function fmtDateTime(ts) {
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return "未知时间";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
         + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function stampForFilename(d) {
    d = d || new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
         + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  /** 会话标题 → 合法文件名主体（Windows / macOS 通用）。 */
  function sanitizeFilename(title) {
    let s = String(title == null ? "" : title).normalize("NFKC").trim();
    s = s.replace(/[\\/:*?"<>|]/g, "_")
         .replace(/[\x00-\x1f]/g, "")
         .replace(/\s+/g, " ")
         .replace(/^\.+/, "")
         .replace(/[. ]+$/, "");
    s = s.slice(0, 40).trim();
    return s || "会话";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------------- 归一化（与 DeepSeek 接口原始结构互转） ----------------

  function idOf(m) {
    if (!m) return null;
    const v = (m.message_id !== undefined && m.message_id !== null) ? m.message_id : m.id;
    return (v === undefined || v === null) ? null : String(v);
  }

  /** 沿 parent_id 从当前分支叶子回溯；叶子缺失返回 null（保留全部）。 */
  function branchIds(msgs, leafId) {
    const byId = new Map();
    for (const m of msgs) {
      const id = idOf(m);
      if (id !== null) byId.set(id, m);
    }
    let cur = (leafId === undefined || leafId === null) ? null : byId.get(String(leafId));
    if (!cur) return null;
    const keep = new Set();
    let guard = 0;
    while (cur && guard++ <= msgs.length + 1) {
      const id = idOf(cur);
      if (id === null) break;
      keep.add(id);
      const p = cur.parent_id;
      cur = (p === undefined || p === null) ? null : byId.get(String(p));
    }
    return keep;
  }

  function extractMessage(m) {
    const role = String(m.role || "").toUpperCase() === "USER" ? "user" : "assistant";
    const contentParts = [], thinkParts = [], searches = [];
    for (const f of (m.fragments || [])) {
      const t = String(f.type || "").toUpperCase();
      const c = f.content || "";
      if (t === "REQUEST" || t === "RESPONSE") { if (c) contentParts.push(c); }
      else if (t === "THINK") { if (c) thinkParts.push(c); }
      else if (t === "TOOL_SEARCH") {
        searches.push({
          query: (f.queries || []).join(", ") || "",
          results: (f.results || []).map((r) => ({ title: r.title || "", url: r.url || "" })),
        });
      }
    }
    if (!contentParts.length && typeof m.content === "string") contentParts.push(m.content);
    if (!thinkParts.length && typeof m.thinking_content === "string") thinkParts.push(m.thinking_content);
    return {
      role,
      inserted_at: m.inserted_at || m.created_at || 0,
      content: contentParts.join("\n\n").trim(),
      thinking: thinkParts.join("\n\n").trim(),
      searches,
    };
  }

  function normalizeSession(cs, chatMessages) {
    cs = cs || {};
    const msgs = Array.isArray(chatMessages) ? chatMessages : [];
    const keep = branchIds(msgs, cs.current_message_id);
    const out = [];
    for (const m of msgs) {
      const id = idOf(m);
      if (keep && (id === null || !keep.has(id))) continue;
      out.push(extractMessage(m));
    }
    out.sort((a, b) => a.inserted_at - b.inserted_at);
    return {
      id: String(cs.id || ""),
      title: cs.title || "(未命名会话)",
      updated_at: cs.updated_at || 0,
      model_type: cs.model_type || "",
      messages: out,
    };
  }

  /** 容错解析官方「导出全部历史对话」里的单个会话对象。 */
  function officialToSession(item) {
    const msgsRaw = item.messages || item.chat_messages || item.items || [];
    const out = [];
    for (const m of msgsRaw) {
      if (!m || typeof m !== "object") continue;
      const roleS = String(m.role || m.author || "").toLowerCase();
      let content = m.content != null ? m.content : (m.text != null ? m.text : m.message);
      if (Array.isArray(content)) {
        content = content.map((p) => (p && typeof p === "object" ? (p.text || "") : String(p))).join("\n\n");
      }
      if (content && typeof content === "object") content = JSON.stringify(content);
      out.push({
        role: (roleS === "user" || roleS === "human" || roleS === "request") ? "user" : "assistant",
        inserted_at: m.inserted_at || m.created_at || m.timestamp || 0,
        content: String(content || "").trim(),
        thinking: String(m.thinking_content || m.thinking || "").trim(),
        searches: [],
      });
    }
    return {
      id: String(item.id || item.conversation_id || item.session_id || ""),
      title: item.title || item.name || "(未命名会话)",
      updated_at: item.updated_at || 0,
      model_type: item.model_type || "",
      messages: out,
    };
  }

  // ---------------- 消息级 HTML（预览与导出文件共用） ----------------

  function renderMessageHtml(m) {
    const role = m.role === "user" ? "user" : (m.role === "assistant" ? "ai" : "raw");
    const who = m.role === "user" ? "👤 用户"
              : m.role === "assistant" ? "🤖 DeepSeek" : "📄 文本";
    const time = m.inserted_at ? fmtDateTime(m.inserted_at) : "";
    let h = '<section class="msg ' + role + '">';
    h += '<div class="who">' + who + (time ? ' <time>' + escapeHtml(time) + "</time>" : "") + "</div>";
    if (m.thinking) {
      h += '<details class="think"><summary>💭 思考过程（点击展开）</summary><div>'
         + escapeHtml(m.thinking) + "</div></details>";
    }
    h += '<div class="body">' + escapeHtml(m.content || "（空消息）") + "</div>";
    if (m.searches && m.searches.length) {
      h += '<div class="refs">🔍 联网搜索：';
      h += m.searches.map((sr) => {
        const q = escapeHtml(sr.query || "未记录关键词");
        const lis = (sr.results || []).filter((r) => r.title || r.url).map((r) =>
          '<li><a href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener noreferrer">'
          + escapeHtml(r.title || r.url) + "</a></li>").join("");
        return "<div>" + q + (lis ? "<ul>" + lis + "</ul>" : "") + "</div>";
      }).join("");
      h += "</div>";
    }
    h += "</section>";
    return h;
  }

  function renderMessagesHtml(messages) {
    return (messages || []).map(renderMessageHtml).join("\n");
  }

  // ---------------- TXT ----------------

  function buildTxt(s) {
    const L = [];
    L.push("DeepSeek 会话记录");
    L.push("标题：" + (s.title || "(未命名会话)"));
    if (s.id) L.push("会话 ID：" + s.id);
    L.push("导出时间：" + fmtDateTime(Math.floor(Date.now() / 1000)));
    L.push("消息数：" + (s.messages ? s.messages.length : 0));
    if (s.model_type) L.push("模型：" + s.model_type);
    L.push("");
    L.push("=".repeat(46));
    for (const m of s.messages || []) {
      L.push("");
      L.push(m.role === "user"
        ? "【用户】 " + (m.inserted_at ? fmtDateTime(m.inserted_at) : "")
        : "【DeepSeek】 " + (m.inserted_at ? fmtDateTime(m.inserted_at) : ""));
      if (m.thinking) { L.push("（思考过程）"); L.push(m.thinking); L.push(""); }
      for (const sr of m.searches || []) {
        L.push("（联网搜索：" + (sr.query || "未记录关键词") + "）");
        for (const r of sr.results || []) {
          if (r.title || r.url) L.push("  - " + (r.title || "") + " " + (r.url || ""));
        }
        L.push("");
      }
      L.push(m.content || "（空消息）");
      L.push("");
    }
    L.push("（完）");
    L.push("");
    return L.join("\n");
  }

  // ---------------- 单文件 HTML 导出 ----------------

  const HTML_CSS = `
    body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7}
    .wrap{max-width:820px;margin:0 auto;padding:24px 16px 64px}
    header.hd{background:linear-gradient(135deg,#0b1220,#1e3a8a);color:#fff;border-radius:14px;padding:22px 24px;margin-bottom:18px}
    header.hd h1{margin:0 0 6px;font-size:20px}
    header.hd .meta{font-size:12.5px;opacity:.85}
    .msg{background:#fff;border:1px solid #e5e7eb;border-left:4px solid #cbd5e1;border-radius:10px;padding:12px 16px;margin:12px 0;white-space:pre-wrap;word-break:break-word}
    .msg.user{border-left-color:#2563eb}
    .msg.ai{border-left-color:#16a34a}
    .msg.raw{border-left-color:#9ca3af}
    .who{font-size:12.5px;color:#6b7280;margin-bottom:6px}
    .who time{margin-left:6px}
    .think{margin:6px 0}
    .think summary{cursor:pointer;color:#6b7280;font-size:12.5px}
    .think div{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:8px 12px;margin-top:6px;color:#475569}
    .refs{font-size:12.5px;color:#6b7280;margin-top:6px}
    .refs ul{margin:4px 0 0 18px;padding:0}
    .body{font-size:14.5px}
    footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af}
  `;

  function buildHtml(s) {
    const title = escapeHtml(s.title || "(未命名会话)");
    const meta = [
      s.id ? "会话 ID " + escapeHtml(s.id) : "",
      "导出时间 " + escapeHtml(fmtDateTime(Math.floor(Date.now() / 1000))),
      (s.messages ? s.messages.length : 0) + " 条消息",
      s.model_type ? "模型 " + escapeHtml(s.model_type) : "",
    ].filter(Boolean).join(" · ");
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + "<title>" + title + " · DeepSeek 对话导出</title>\n"
      + "<style>" + HTML_CSS + "</style>\n</head>\n<body>\n<div class=\"wrap\">\n"
      + "<header class=\"hd\"><h1>" + title + "</h1><div class=\"meta\">" + meta + "</div></header>\n"
      + "<main>\n" + renderMessagesHtml(s.messages) + "\n</main>\n"
      + "<footer>由 DeepSeek 会话导出工具生成 · 非官方 · " + escapeHtml(stampForFilename()) + "</footer>\n"
      + "</div>\n</body>\n</html>\n";
  }

  return {
    fmtDateTime,
    stampForFilename,
    sanitizeFilename,
    escapeHtml,
    normalizeSession,
    officialToSession,
    renderMessagesHtml,
    buildTxt,
    buildHtml,
    _extractMessage: extractMessage,
    _branchIds: branchIds,
  };
});
