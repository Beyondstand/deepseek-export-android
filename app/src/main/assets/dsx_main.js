/* ============================================================================
 * dsx_main.js v0.4 — 「DeepSeek 会话导出」App 注入脚本。
 * 由 MainActivity 在 chat.deepseek.com 页面加载完成后注入（幂等）。
 *
 * v0.4：把「接手提示词 + 完整对话(MD)」分享给千问/夸克，继承原对话上下文。
 * v0.5：导出后「夸克/通义千问」两按钮直接唤起应用。
 * v0.6：ACTION_SEND 落点不对 → 改「复制全文并打开」两步法，喂 AI 用纯文本。
 * v0.7 变化：大对话体量分流（精简接手包）。
 * v0.8 变化（真机反馈：千问手机版不支持 .md 文件上传）→ 大对话改「分段复制」：
 *   导出时按 UNIT_CHARS（8 千字）/段拆好存 App 内；点「夸克/千问」复制第 1 段
 *   （含接手提示词）并打开应用；之后点「复制下一段」逐段粘贴发送，最后一段
 *   自带「发送完毕」尾注；分段进度持久化、可重置。buildDigest 移除。
 *
 * v0.3 变化（真机验证 v0.2 后的用户反馈）：
 *   - 导出只存 Markdown（.md），不再出 HTML/TXT 文件；
 *   - 导出内容同时存在 App 内（「最近导出」最多 10 条，localStorage 持久化、
 *     满则自动缩减），每条可一键复制全文 / 就地查看；
 *   - 悬浮胶囊更醒目：加大加粗、亮蓝底、白描边、光晕。
 *
 * 链路（沿用已验证事实）：读 localStorage.userToken → 同源请求
 * /api/v0/chat/history_messages → 归一化裁剪当前分支 → buildMd →
 * 经原生桥 DSExport.saveFile 存入系统 Download 目录 + App 内缓存 →
 * 页内 + 原生双确认；复制走 DSExport.copy（原生剪贴板，最稳）。
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__DSX_MAIN__) return; // 幂等：整页刷新由 Java 侧重新注入
  window.__DSX_MAIN__ = true;

  var VERSION = "v0.8";

  /* ---------------- 小工具 ---------------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function nowStr() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css; /* 只用内联样式，不插 <style>，避开页面 CSP */
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtPos(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + "MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + "KB";
    return n + "B";
  }

  /* ---------------- 状态与诊断 ---------------- */
  var S = { log: [], busy: false,
            counts: { api: 0, fail: 0, save: 0 }, token: null,
            exports: [],   // 最近导出（App 内缓存）：[{name,len,content}]，最多 10 条
            lastExport: null, // 最近一次导出（内存），供「导出后两个 AI 按钮」直接发送
            lastMsg: "初始化…", lastLevel: "info" };
  var ui = {};

  (function loadExports() {
    try {
      var raw = localStorage.getItem("dsx_exports");
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) S.exports = arr.filter(function (x) { return x && x.name; }).slice(0, 10);
    } catch (_) { S.exports = []; }
  })();

  /** 持久化最近导出；localStorage 放不下就从旧到新逐条缩减，全放不下就只留内存。 */
  function persistExports() {
    for (var keep = S.exports.length; keep >= 0; keep--) {
      try { localStorage.setItem("dsx_exports", JSON.stringify(S.exports.slice(0, keep))); return; }
      catch (_) { /* 缩减后重试 */ }
    }
  }

  function diag(text, level) { // level: "info" | "ok" | "bad"
    S.lastMsg = text;
    S.lastLevel = level || "info";
    S.log.push(nowStr() + " " + (level === "bad" ? "✗ " : level === "ok" ? "✓ " : "· ") + text);
    if (S.log.length > 80) S.log.shift();
    try { console.log("[DSX " + VERSION + "] " + text); } catch (_) {}
    renderStatus();
  }

  function renderStatus() {
    if (!ui.status) return;
    ui.status.textContent = (S.token ? "已登录" : "未登录")
      + (S.busy ? " · 处理中…" : " · ") + S.lastMsg;
    ui.status.style.color =
      S.lastLevel === "bad" ? "#f87171" : S.lastLevel === "ok" ? "#34d399" : "#d1d5db";
    if (ui.counts)
      ui.counts.textContent = "API " + S.counts.api + " · 已存 " + S.counts.save
        + " · 失败 " + S.counts.fail;
    if (ui.logBox && ui.logBox.style.display !== "none")
      ui.logBox.textContent = S.log.join("\n") || "（暂无日志）";
    if (ui.dot)
      ui.dot.style.background = S.lastLevel === "bad" ? "#ef4444"
        : (S.token ? "#22c55e" : "#9ca3af");
  }

  /* ---------------- 登录态（同源读 localStorage.userToken） ---------------- */
  function getToken() {
    try {
      var raw = localStorage.getItem("userToken");
      if (!raw) return null;
      try { var o = JSON.parse(raw); return o.value || o.token || raw; }
      catch (_) { return raw; }
    } catch (_) { return null; }
  }
  function tokenLoop() {
    var t = getToken();
    if (!!t !== !!S.token)
      diag(t ? "检测到登录态（userToken 已出现）" : "登录态消失", t ? "ok" : "info");
    S.token = t;
    renderStatus();
    setTimeout(tokenLoop, 4000);
  }

  /* ---------------- 原生桥 ---------------- */
  function bridge() { return window.DSExport || null; }

  function saveViaBridge(name, mime, content) {
    var b = bridge();
    if (!b) throw new Error("原生桥 DSExport 不可用（注入异常）");
    var raw;
    try { raw = b.saveFile(name, mime, content); }
    catch (e) { throw new Error("桥接调用异常：" + ((e && e.message) || e)); }
    var r;
    try { r = JSON.parse(raw); }
    catch (_) { throw new Error("桥返回无法解析：" + String(raw).slice(0, 120)); }
    if (!r || !r.ok) throw new Error((r && r.error) || "保存失败（未知错误）");
    return r;
  }

  /** 复制全文：优先原生剪贴板桥（最稳），再退 navigator.clipboard / execCommand。 */
  function copyText(text) {
    var b = bridge();
    if (b && b.copy) {
      try { b.copy(text); return true; } catch (_) {}
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
      return true;
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }

  /* ---------------- 接口（同源 fetch；包络规则见网页版已验证事实） ---------------- */
  function api(path) {
    var token = getToken();
    if (!token)
      return Promise.reject(new Error("未登录（localStorage 无 userToken）：请先在本页登录 DeepSeek"));
    S.counts.api++;
    renderStatus();
    return fetch("https://chat.deepseek.com" + path, {
      credentials: "include",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "x-client-platform": "web",
        "x-client-version": "2.8.0",
        "x-client-locale": "zh_CN",
      },
    })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (j) {
        // 成功 = code==0 且 biz_code==0；无 token 时 HTTP 200 + {"code":40003,"msg":"INVALID_TOKEN"}
        if (j.code !== 0) {
          if (j.code === 40003 || j.msg === "INVALID_TOKEN")
            throw new Error("登录已失效（INVALID_TOKEN）：请在本页退出并重新登录后再试");
          throw new Error("接口错误 code=" + j.code + " " + (j.msg || ""));
        }
        var d = j.data || {};
        if (d.biz_code !== undefined && d.biz_code !== 0)
          throw new Error("业务错误 biz_code=" + d.biz_code);
        return d.biz_data || {};
      });
  }

  /* ---------------- 当前会话 ID（地址栏路由） ---------------- */
  function currentSessionId() {
    var m = location.pathname.match(/\/a\/chat\/s\/([^\/?#]+)/); // 网页版已验证路由
    if (m) return { id: m[1], how: "/a/chat/s/" };
    m = location.pathname.match(/^\/a\/([^\/?#]+)/); // 兼容可能的旧/简路由
    if (m) return { id: m[1], how: "/a/" };
    return null;
  }

  /* ---------------- 导出当前对话（Markdown） ---------------- */
  function exportCurrent() {
    if (S.busy) { toastMsg("正在导出中，请稍候", true); return; }
    if (!bridge()) { diag("原生桥 DSExport 不可用（注入异常）", "bad"); return; }
    if (!window.DSExp) { diag("核心 DSExp 未加载，无法导出", "bad"); return; }
    var where = currentSessionId();
    if (!where) {
      diag("当前页面不是对话页（地址需为 /a/…）：请先打开一个会话再导出", "bad");
      toastMsg("⚠ 请先打开一个会话（点进任意对话）再导出", true);
      return;
    }
    S.busy = true;
    renderStatus();
    diag("开始导出当前对话（" + where.how + " 匹配 ID …" + where.id.slice(-6) + "）");
    api("/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent(where.id)
        + "&cache_version=0")
      .then(function (biz) {
        // biz_data = { chat_session:{current_message_id,...}, chat_messages:[...] }
        var cs = biz.chat_session || {};
        var s = DSExp.normalizeSession(cs, biz.chat_messages || []); // 沿 parent_id 裁剪到当前分支
        if (!s.id) s.id = where.id;
        if (!s.title || s.title === "(未命名会话)") s.title = "会话";
        var content = DSExp.buildMd(s);
        var plain = DSExp.buildTxt(s); // 喂给 AI 的纯文本版（千问不收 MD）
        var units = plain.length > FEED_FULL_LIMIT
          ? DSExp.splitPlainUnits(plain, UNIT_CHARS) : null; // 大对话分段
        var name = "DeepSeek_" + DSExp.sanitizeFilename(s.title) + "_"
                 + DSExp.stampForFilename() + ".md";
        diag("拉取成功：" + s.messages.length + " 条消息，生成 Markdown " + fmtBytes(content.length)
          + (units ? "，分 " + units.length + " 段" : ""));
        var item = addExport(name, content, plain, units); // 储存在 App 内：随取随复制
        S.lastExport = item;
        showFeedStrip();
        var r = saveViaBridge(name, "text/markdown;charset=utf-8", content);
        S.counts.save++;
        diag("已保存 " + r.path + "（「最近导出」可一键复制全文）", "ok");
        toastMsg("✅ 已导出：" + r.name + "\n" + s.messages.length + " 条消息 → Download 目录\n点下方「夸克 / 通义千问」：复制全文并打开粘贴");
        try { bridge().toast("DS导出：已保存 " + r.name); } catch (_) {}
      })
      .catch(function (e) {
        S.counts.fail++;
        var msg = (e && e.message) || String(e);
        diag("导出失败：" + msg, "bad");
        toastMsg("⚠ 导出失败：" + msg, true);
      })
      .then(function () {
        S.busy = false;
        renderStatus();
      });
  }

  /* ---------------- 发给千问 / 夸克：直接唤起指定 AI 客户端 ---------------- */

  /* 接手提示词：让目标 AI 把下面的记录当作自己的对话记忆并继续服务。
   * 已替用户写好；想自定义就改 PROMPT_RULES / buildFeedText 的两段引言
   * （导出正文会接在提示词后面）。 */
  var PROMPT_RULES = [
    "1. 把它当作你自己的对话记忆：延续已有话题、目标和进度，从我停止的地方继续当我的助手；",
    "2. 记住对话中我的背景、偏好和约束，后续回答保持一致，不要让我重复已知信息；",
    "3. 如果对话结尾我的问题还没解决，请直接接着解决并给出结果；",
    "4. 引用对话内容时忠实原文，不要编造我没说过的话；",
    "5. 之后请沿用对话中的语言和风格回答。",
  ].join("\n");
  var PROMPT_TAIL =
    "记录中「【用户】」开头的是我，「【DeepSeek】」开头的是原助手；（思考过程）（联网搜索）是原助手的辅助内容，可作背景参考。";

  /** 组装喂给 AI 的完整文本；mode="full" 或 {k,N}=分段首段。 */
  function buildFeedText(body, mode) {
    var intro;
    if (mode === "full") {
      intro = "我想让你「接手」一段我和另一个 AI 助手（DeepSeek）的对话。\n"
        + "下面是完整的对话记录（纯文本格式），请通读后：";
    } else {
      intro = "我想让你「接手」一段我和另一个 AI 助手（DeepSeek）的对话。\n"
        + "对话记录较长，将分 " + mode.N + " 条消息发送，此为第 " + mode.k + "/" + mode.N
        + " 条；请先记住本条内容，后续各条紧随其后，全部收完后从记录最后一条继续当我的助手：";
    }
    return intro + "\n" + PROMPT_RULES + "\n\n" + PROMPT_TAIL
      + "\n\n---\n（以下为对话记录）\n\n" + body;
  }

  /* 体量阈值与分段参数（v0.8）：大对话走「分段复制」流程 */
  var FEED_FULL_LIMIT = 80000; // 完整复制的字符上限（约 8 万字），超过走分段
  var UNIT_CHARS = 8000;       // 每段字符预算（约 8 千字，适配应用输入框）

  /* 直达目标（v0.5）：导出后出现两个按钮，点选直接唤起对应应用；
   * 未安装/未注册接收分享时，原生侧自动退回系统分享面板，内容不丢。 */
  var AI_TARGETS = [
    { label: "🌐 夸克浏览器", pkg: "com.quark.browser" },
    { label: "🤖 通义千问", pkg: "com.aliyun.tongyi" },
  ];

  function feedTo(pkg, appName, x, label) {
    var b = bridge();
    if (!b || !b.openApp || !b.copy) { diag("原生桥不支持复制/唤起（请确认 App 已更新到 0.8+）", "bad"); return; }
    var text, mode;
    if (x.len > FEED_FULL_LIMIT) {
      var units = ensureUnits(x);
      if (!units || !units.length) { diag("分段失败，请重新导出", "bad"); return; }
      x.unitSent = 1;
      persistExports();
      text = buildFeedText(units[0], { k: 1, N: units.length });
      mode = "unit";
    } else {
      text = buildFeedText(x.plain || x.content, "full");
      mode = "full";
    }
    try { b.copy(text); }
    catch (e) { diag("复制失败：" + ((e && e.message) || e), "bad"); return; }
    diag("已复制（" + fmtBytes(text.length)
      + (mode === "unit" ? "，第 1/" + x.units.length + " 段" : "，完整")
      + "），唤起 " + appName + "：" + label);
    try { b.openApp(pkg); }
    catch (e) {
      diag("唤起失败：" + ((e && e.message) || e), "bad");
      toastMsg("⚠ 全文已在剪贴板，但唤起 " + appName + " 失败，可手动打开后粘贴", true);
      return;
    }
    if (mode === "unit") {
      toastMsg("✅ 已复制第 1/" + x.units.length + " 段\n已打开 " + appName + "：粘贴发送\n回 App 点「复制下一段」继续，发完即可接手");
      renderUnitProgress(x);
    } else {
      toastMsg("✅ 提示词+全文已复制（纯文本）\n已打开 " + appName + "：\n进 AI 聊天 → 长按输入框 → 粘贴 → 发送");
    }
  }

  /** 确保大对话的分段已生成（按需生成并持久化到缓存）。 */
  function ensureUnits(x) {
    if (x.len <= FEED_FULL_LIMIT) return null;
    if (!x.units || !x.units.length) {
      x.units = DSExp.splitPlainUnits(x.plain || x.content, UNIT_CHARS);
      persistExports();
    }
    return x.units;
  }

  /** 第 k（>1）段文本：带接续说明；最后一段带「发送完毕」尾注。 */
  function unitText(units, k) {
    var N = units.length;
    var t = "（DeepSeek 对话记录 第 " + k + "/" + N + " 条，紧接上一条消息）\n\n" + units[k - 1];
    if (k === N) t += "\n\n---\n（对话记录发送完毕，共 " + N + " 条。请从最后一条继续当我的助手。）";
    return t;
  }

  /** 分段流程：复制下一段（只复制不打开——用户在目标应用与 App 间切换接力）。 */
  function copyNextUnit(x) {
    var b = bridge();
    if (!b || !b.copy) { diag("原生桥不支持复制", "bad"); return; }
    var units = ensureUnits(x);
    if (!units) { diag("该记录无需分段", "bad"); return; }
    var k = (x.unitSent || 0) + 1;
    if (k > units.length) {
      diag("全部分段已复制（" + units.length + " 段）", "ok");
      toastMsg("✅ 共 " + units.length + " 段已全部复制发送完毕；如需重头再来点「重置」");
      return;
    }
    var text = k === 1 ? buildFeedText(units[0], { k: 1, N: units.length }) : unitText(units, k);
    try { b.copy(text); }
    catch (e) { diag("复制失败：" + ((e && e.message) || e), "bad"); return; }
    x.unitSent = k;
    persistExports();
    renderUnitProgress(x);
    diag("已复制第 " + k + "/" + units.length + " 段", "ok");
    toastMsg("📋 已复制第 " + k + "/" + units.length + " 段\n切到 AI 应用粘贴发送，再回来取下一段");
  }

  /** 重置某条记录的分段进度。 */
  function resetUnit(x) {
    x.unitSent = 0;
    persistExports();
    renderUnitProgress(x);
    diag("分段进度已重置");
  }

  /** 分段进度条（大对话才显示）。 */
  function renderUnitProgress(x) {
    x = x || S.lastExport;
    if (!ui.unitLine) return;
    if (x && ensureUnits(x)) {
      ui.unitLabel.textContent = "分段进度：已复制 " + (x.unitSent || 0) + "/" + x.units.length + " 段";
      ui.unitLine.style.display = "block";
    } else {
      ui.unitLine.style.display = "none";
    }
  }

  /** 「导出后」按钮：按体量复制（完整或精简包）并打开目标应用。 */
  function feedLast(t) {
    if (!S.lastExport) {
      diag("还没有刚导出的内容：先点「导出当前对话」", "bad");
      toastMsg("⚠ 先导出一次，再选 AI 接着聊", true);
      return;
    }
    feedTo(t.pkg, t.label, S.lastExport, S.lastExport.name);
  }

  /** 导出成功后显示（或更新）「选个 AI 接着聊」按钮条。 */
  function showFeedStrip() {
    if (!ui.feedStrip) return;
    if (ui.feedStripTxt && S.lastExport)
      ui.feedStripTxt.textContent = "刚导出：" + S.lastExport.name + " → 选个 AI 接着聊";
    ui.feedStrip.style.display = "block";
  }

  /* ---------------- 最近导出（App 内缓存） ---------------- */
  function addExport(name, md, plain, units) {
    var item = { name: name, time: nowStr(), len: md.length,
                 content: md, plain: plain, units: units, unitSent: 0 };
    S.exports.unshift(item);
    if (S.exports.length > 10) S.exports.length = 10;
    persistExports();
    renderExports();
    return item;
  }

  function renderExports() {
    if (!ui.exportsList) return;
    ui.exportsList.textContent = "";
    if (!S.exports.length) {
      ui.exportsList.appendChild(el("div",
        "color:#6b7280;font-size:12px;padding:4px 0;",
        "（暂无：点上面按钮导出后，这里可随时复制全文）"));
      return;
    }
    S.exports.forEach(function (x) {
      var row = el("div", "border:1px solid #1f2937;border-radius:10px;padding:8px 10px;margin:6px 0;");
      var line = el("div", "display:flex;align-items:center;gap:10px;");
      line.appendChild(el("span",
        "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        + "font-size:12.5px;color:#e5e7eb;",
        "📄 " + x.name + " · " + fmtBytes(x.len)
          + (x.len > FEED_FULL_LIMIT ? " · 大（分段复制）" : "")));
      var copyBtn = el("a", LINK_CSS, "复制");
      copyBtn.onclick = function () {
        if (!x.content) { diag("该条过大未缓存全文，请到 Download 目录打开文件", "bad"); return; }
        if (copyText(x.content)) {
          diag("已复制 " + x.name + " 全文", "ok");
          toastMsg("📋 已复制：" + x.name);
        } else {
          diag("复制失败，请用「查看」打开后长按选择复制", "bad");
        }
      };
      line.appendChild(copyBtn);
      var ftQuark = el("a", LINK_CSS, "夸克");
      ftQuark.onclick = function () {
        if (!x.content) { diag("该条过大未缓存全文，请先重新导出当前对话", "bad"); return; }
        feedTo("com.quark.browser", "夸克浏览器", x, x.name);
      };
      line.appendChild(ftQuark);
      var ftTongyi = el("a", LINK_CSS, "千问");
      ftTongyi.onclick = function () {
        if (!x.content) { diag("该条过大未缓存全文，请先重新导出当前对话", "bad"); return; }
        feedTo("com.aliyun.tongyi", "通义千问", x, x.name);
      };
      line.appendChild(ftTongyi);
      if (x.len > FEED_FULL_LIMIT) {
        var nx = el("a", LINK_CSS, "下一段");
        nx.onclick = function () {
          if (!x.content) { diag("该条过大未缓存全文，请先重新导出当前对话", "bad"); return; }
          copyNextUnit(x);
        };
        line.appendChild(nx);
      }
      var viewBtn = el("a", LINK_CSS, "查看");
      line.appendChild(viewBtn);
      row.appendChild(line);
      var box = el("pre",
        "display:none;margin:6px 0 0;background:#000;color:#a7f3d0;border-radius:8px;"
        + "padding:8px 10px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;"
        + "font:11px/1.5 Menlo,Consolas,monospace;",
        x.content || "（内容过大未缓存，请打开 Download 里的 .md 文件）");
      row.appendChild(box);
      viewBtn.onclick = function () {
        box.style.display = box.style.display === "none" ? "block" : "none";
      };
      ui.exportsList.appendChild(row);
    });
  }

  /* ---------------- 页内 toast（顶部居中，避开键盘与胶囊） ---------------- */
  function toastMsg(msg, bad) {
    var t = document.getElementById("dsx-toast");
    if (!t) {
      t = el("div",
        "position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);"
        + "z-index:2147483647;color:#fff;padding:10px 16px;border-radius:10px;"
        + "font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;white-space:pre-line;"
        + "box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:86vw;transition:opacity .4s;pointer-events:none;");
      t.id = "dsx-toast";
      document.body.appendChild(t);
    }
    t.style.background = bad ? "#7f1d1d" : "#065f46";
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t.__h);
    t.__h = setTimeout(function () {
      t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.remove(); }, 500);
    }, 5000);
  }

  /* ---------------- 样式常量 ---------------- */
  /* 胶囊：亮蓝底 + 白描边 + 光晕，加大加粗——更明显（v0.3 用户反馈） */
  var PILL_CSS =
      "position:fixed;z-index:2147483647;left:12px;right:auto;top:auto;"
    + "bottom:calc(14px + env(safe-area-inset-bottom));"
    + "background:#2563eb;color:#fff;padding:13px 20px;border-radius:999px;"
    + "font:700 15px/1 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.5px;"
    + "box-shadow:0 6px 24px rgba(37,99,235,.7),0 0 0 2px rgba(255,255,255,.4);"
    + "cursor:pointer;user-select:none;-webkit-user-select:none;"
    + "touch-action:none;white-space:nowrap;";
  var DOT_CSS =
      "display:inline-block;width:10px;height:10px;border-radius:50%;"
    + "background:#9ca3af;border:2px solid #fff;margin-left:9px;";
  var SHEET_CSS =
      "position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:0;"
    + "width:min(94vw,560px);background:rgba(17,24,39,.95);color:#e5e7eb;"
    + "border-radius:14px 14px 0 0;box-shadow:0 -6px 24px rgba(0,0,0,.5);"
    + "font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;"
    + "padding:12px 16px calc(14px + env(safe-area-inset-bottom));";
  var STATUS_CSS =
      "background:#0b1220;border:1px solid #1f2937;border-radius:8px;padding:7px 10px;"
    + "margin:8px 0 2px;font-size:12px;white-space:pre-wrap;word-break:break-all;";
  var BTN_CSS =
      "display:inline-block;padding:10px 14px;border:0;border-radius:10px;color:#fff;"
    + "font:600 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;"
    + "margin:4px 8px 4px 0;";
  var LINK_CSS = "color:#93c5fd;text-decoration:underline;cursor:pointer;";
  var PRE_CSS =
      "display:none;margin:8px 0 0;background:#000;color:#a7f3d0;border-radius:8px;"
    + "padding:8px 10px;max-height:170px;overflow:auto;white-space:pre-wrap;"
    + "font:11px/1.5 Menlo,Consolas,monospace;";

  /* ---------------- UI 构建（SPA 若移除节点则由看门狗重建） ---------------- */
  function buildUi() {
    var body = document.body;
    if (!body) { setTimeout(buildUi, 300); return; }

    var oldPill = document.getElementById("dsx-pill");
    if (oldPill) oldPill.remove();
    var oldSheet = document.getElementById("dsx-sheet");
    if (oldSheet) oldSheet.remove();

    /* --- 底部面板 --- */
    var sheet = el("div", SHEET_CSS);
    sheet.id = "dsx-sheet";
    sheet.style.display = "none";

    var head = el("div", "display:flex;align-items:center;gap:8px;");
    head.appendChild(el("b", "font-size:14px;color:#fff;", "DeepSeek 会话导出"));
    head.appendChild(el("span", "margin-left:auto;color:#9ca3af;font-size:11px;",
      VERSION + " · 桥" + (bridge() ? "就绪" : "不可用")));
    var close = el("a", LINK_CSS + "margin-left:14px;", "收起");
    head.appendChild(close);
    sheet.appendChild(head);

    var status = el("div", STATUS_CSS, "初始化…");
    sheet.appendChild(status);

    var row = el("div", "margin:10px 0 4px;");
    var exportBtn = el("button", BTN_CSS + "background:#2563eb;", "📤 导出当前对话");
    var openBtn = el("button", BTN_CSS + "background:#374151;", "📂 下载目录");
    row.appendChild(exportBtn);
    row.appendChild(openBtn);
    sheet.appendChild(row);

    /* --- 导出后：两个按钮直接唤起指定 AI 客户端 --- */
    var feedStrip = el("div", "display:none;border:1px dashed #374151;border-radius:10px;padding:8px 10px;margin:10px 0 2px;");
    var stripTxt = el("div", "font-size:12px;color:#93c5fd;margin-bottom:6px;", "刚导出的对话 → 点选 App：复制全文并打开粘贴");
    feedStrip.appendChild(stripTxt);
    var feedRow = el("div", "");
    AI_TARGETS.forEach(function (t) {
      var b = el("button", BTN_CSS + "background:#7c3aed;", t.label);
      b.onclick = function () { feedLast(t); };
      feedRow.appendChild(b);
    });
    feedStrip.appendChild(feedRow);

    /* 分段进度（大对话显示）：复制下一段 / 重置 */
    var unitLine = el("div", "display:none;margin-top:8px;font-size:12px;color:#93c5fd;");
    var unitLabel = el("span", "", "");
    unitLine.appendChild(unitLabel);
    var nextBtn = el("a", LINK_CSS + "margin-left:10px;", "复制下一段");
    unitLine.appendChild(nextBtn);
    var resetBtn = el("a", LINK_CSS + "margin-left:10px;", "重置");
    unitLine.appendChild(resetBtn);
    feedStrip.appendChild(unitLine);
    ui.unitLine = unitLine;
    ui.unitLabel = unitLabel;
    nextBtn.onclick = function () { if (S.lastExport) copyNextUnit(S.lastExport); };
    resetBtn.onclick = function () { if (S.lastExport) resetUnit(S.lastExport); };

    sheet.appendChild(feedStrip);
    ui.feedStrip = feedStrip;
    ui.feedStripTxt = stripTxt;

    /* --- 最近导出（存于 App 内，可直接复制） --- */
    var exHead = el("div", "margin-top:10px;font-size:12px;color:#9ca3af;");
    exHead.appendChild(document.createTextNode("最近导出 · 存在 App 内，可直接复制"));
    var clearBtn = el("a", LINK_CSS + "margin-left:10px;", "清空");
    exHead.appendChild(clearBtn);
    sheet.appendChild(exHead);
    var exportsList = el("div", "");
    sheet.appendChild(exportsList);
    ui.exportsList = exportsList;
    clearBtn.onclick = function () {
      S.exports = [];
      persistExports();
      renderExports();
      diag("已清空最近导出缓存");
    };

    var foot = el("div", "margin-top:6px;font-size:11.5px;color:#9ca3af;");
    var logToggle = el("a", LINK_CSS + "margin-right:10px;", "诊断日志");
    var counts = el("span", "", "API 0 · 已存 0 · 失败 0");
    foot.appendChild(logToggle);
    foot.appendChild(counts);
    sheet.appendChild(foot);

    var logBox = el("pre", PRE_CSS, "");
    sheet.appendChild(logBox);

    /* --- 悬浮胶囊 --- */
    var pill = el("div", PILL_CSS);
    pill.id = "dsx-pill";
    pill.appendChild(document.createTextNode("⬇ DS导出"));
    var dot = el("span", DOT_CSS);
    pill.appendChild(dot);

    body.appendChild(pill);
    body.appendChild(sheet);

    ui.pill = pill; ui.dot = dot; ui.sheet = sheet; ui.status = status;
    ui.counts = counts; ui.logBox = logBox;

    function toggleSheet() {
      var open = sheet.style.display === "none";
      sheet.style.display = open ? "block" : "none";
      if (open) renderStatus();
    }
    close.onclick = function () { sheet.style.display = "none"; };

    /* 拖动胶囊；未移动的轻点 = 开合面板 */
    var drag = null;
    pill.addEventListener("pointerdown", function (ev) {
      var rect = pill.getBoundingClientRect();
      drag = { x0: ev.clientX, y0: ev.clientY, moved: false, id: ev.pointerId,
               bx: rect.left, by: rect.top };
      try { pill.setPointerCapture(ev.pointerId); } catch (_) {}
      ev.preventDefault();
    });
    pill.addEventListener("pointermove", function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
      if (!drag.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) drag.moved = true;
      if (drag.moved) {
        pill.style.left = fmtPos(drag.bx + dx, 0, window.innerWidth - pill.offsetWidth) + "px";
        pill.style.top = fmtPos(drag.by + dy, 0, window.innerHeight - pill.offsetHeight) + "px";
        pill.style.right = "auto";
        pill.style.bottom = "auto";
      }
    });
    function endDrag(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved) toggleSheet();
      else {
        try { localStorage.setItem("dsx_pos", pill.style.left + "," + pill.style.top); } catch (_) {}
      }
      drag = null;
    }
    pill.addEventListener("pointerup", endDrag);
    pill.addEventListener("pointercancel", function () { drag = null; });

    /* 记忆胶囊位置 */
    try {
      var p = localStorage.getItem("dsx_pos");
      if (p) {
        var a = p.split(",");
        var x = parseInt(a[0], 10), y = parseInt(a[1], 10);
        if (!isNaN(x) && !isNaN(y)) {
          pill.style.left = fmtPos(x, 0, window.innerWidth - pill.offsetWidth) + "px";
          pill.style.top = fmtPos(y, 0, window.innerHeight - pill.offsetHeight) + "px";
          pill.style.bottom = "auto";
        }
      }
    } catch (_) {}

    /* 按钮行为 */
    exportBtn.onclick = exportCurrent;
    openBtn.onclick = function () {
      var b = bridge();
      if (!b) { diag("原生桥不可用，无法打开下载目录", "bad"); return; }
      try { b.openDownloads(); }
      catch (e) { diag("打开下载目录失败：" + ((e && e.message) || e), "bad"); }
    };
    logToggle.onclick = function () {
      logBox.style.display = logBox.style.display === "none" ? "block" : "none";
      renderStatus();
    };

    renderStatus();
    renderExports();
  }

  /* ---------------- 启动 ---------------- */
  var bootTries = 0;
  function boot() {
    // dsx_core.js 应先于本文件注入；等不到就带病运行（面板仍可见、可诊断）
    if (typeof window.DSExp === "undefined" && bootTries++ < 25) return setTimeout(boot, 200);
    buildUi();
    diag("注入完成 " + VERSION
      + "（核心 " + (window.DSExp ? "已加载" : "缺失")
      + "，原生桥 " + (bridge() ? "就绪" : "不可用") + "）",
      bridge() ? "ok" : "bad");
    tokenLoop();
    if (S.exports.length && S.exports[0].content) { // 有历史导出：恢复「接着聊」按钮条
      S.lastExport = S.exports[0];
      showFeedStrip();
    }
    setInterval(function () { // 看门狗：SPA 移除了节点就重建，保证胶囊常驻
      if (!document.getElementById("dsx-pill")) {
        buildUi();
        diag("悬浮胶囊被页面移除，已自动重建", "bad");
      }
    }, 5000);
  }
  boot();
})();
