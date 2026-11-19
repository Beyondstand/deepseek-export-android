/* ============================================================================
 * dsx_main.js v0.1 — 「DeepSeek 会话导出」App 注入脚本（骨架自检版）。
 * 由 MainActivity 在 chat.deepseek.com 页面加载完成后注入（幂等）。
 *
 * 本版不调用任何 DeepSeek 接口、无需登录，只验证链路四件事：
 *   1. 页内显示可拖动悬浮胶囊 + 底部面板，实时显示注入/登录状态；
 *   2. 每 4 秒读一次 localStorage.userToken → 登录后胶囊圆点变绿；
 *   3. 「🧪 测试保存」：经原生桥 DSExport.saveFile 写一个小 HTML 到系统
 *      Download 目录 —— 验证 注入 → 桥 → MediaStore 保存 全链路；
 *   4. 「📂 打开下载目录」+ 诊断日志（计数徽章式，出问题可照抄反馈）。
 *
 * 下一版（v0.2）在此基础上加入：token → history_messages → 归一化 →
 * 导出当前对话 HTML/TXT。
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__DSX_MAIN__) return; // 幂等：整页刷新由 Java 侧重新注入
  window.__DSX_MAIN__ = true;

  var VERSION = "v0.1";

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

  /* ---------------- 状态与诊断 ---------------- */
  var S = { log: [], busy: false, counts: { save: 0, fail: 0 }, token: null,
            lastMsg: "初始化…", lastLevel: "info" };
  var ui = {};

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
    if (ui.counts) ui.counts.textContent = "已存 " + S.counts.save + " · 失败 " + S.counts.fail;
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
  var PILL_CSS =
      "position:fixed;z-index:2147483647;left:12px;right:auto;top:auto;"
    + "bottom:calc(12px + env(safe-area-inset-bottom));"
    + "background:rgba(17,24,39,.88);color:#fff;padding:9px 13px;border-radius:999px;"
    + "font:600 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;"
    + "box-shadow:0 4px 14px rgba(0,0,0,.45);cursor:pointer;user-select:none;"
    + "-webkit-user-select:none;touch-action:none;white-space:nowrap;";
  var DOT_CSS =
      "display:inline-block;width:8px;height:8px;border-radius:50%;"
    + "background:#9ca3af;margin-left:7px;";
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
    var testBtn = el("button", BTN_CSS + "background:#2563eb;", "🧪 测试保存");
    var openBtn = el("button", BTN_CSS + "background:#374151;", "📂 打开下载目录");
    row.appendChild(testBtn);
    row.appendChild(openBtn);
    sheet.appendChild(row);

    var foot = el("div", "margin-top:6px;font-size:11.5px;color:#9ca3af;");
    var logToggle = el("a", LINK_CSS + "margin-right:10px;", "诊断日志");
    var counts = el("span", "", "已存 0 · 失败 0");
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
    testBtn.onclick = testSave;
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
  }

  /* ---------------- 测试保存（不依赖登录与接口） ---------------- */
  function testSave() {
    if (S.busy) { toastMsg("正在处理中，请稍候", true); return; }
    S.busy = true;
    renderStatus();
    setTimeout(function () { // 让「处理中」状态先渲染出来
      try {
        var stamp = window.DSExp ? DSExp.stampForFilename() : String(Date.now());
        var content = '<!doctype html><html><head><meta charset="utf-8">'
          + "<title>DeepSeek 导出 App 自检</title></head>"
          + "<body style=\"font:14px/1.8 system-ui,sans-serif;max-width:560px;margin:40px auto\">"
          + "<h3>✅ 桥接链路自检成功</h3>"
          + "<p>注入脚本 " + VERSION + " · 生成时间 " + new Date().toLocaleString() + "</p>"
          + "<p>看到这个文件说明：页面注入 ✓ → 原生桥 DSExport ✓ → MediaStore 保存 ✓。</p>"
          + "</body></html>";
        var r = saveViaBridge("DeepSeek_桥接自检_" + stamp + ".html",
                              "text/html;charset=utf-8", content);
        S.counts.save++;
        diag("测试保存成功：" + r.path, "ok");
        toastMsg("✅ 已保存测试文件：\n" + r.path + "\n（手机「下载」目录）");
        try { bridge().toast("DS导出：测试保存成功 " + r.name); } catch (_) {}
      } catch (e) {
        S.counts.fail++;
        diag("测试保存失败：" + ((e && e.message) || e), "bad");
        toastMsg("⚠ 测试保存失败：" + ((e && e.message) || e), true);
      }
      S.busy = false;
      renderStatus();
    }, 30);
  }

  /* ---------------- 启动 ---------------- */
  var bootTries = 0;
  function boot() {
    // dsx_core.js 应先于本文件注入；等不到就带病运行（测试保存不依赖核心）
    if (typeof window.DSExp === "undefined" && bootTries++ < 25) return setTimeout(boot, 200);
    buildUi();
    diag("注入完成 " + VERSION
      + "（核心 " + (window.DSExp ? "已加载" : "缺失")
      + "，原生桥 " + (bridge() ? "就绪" : "不可用") + "）",
      bridge() ? "ok" : "bad");
    tokenLoop();
    setInterval(function () { // 看门狗：SPA 移除了节点就重建，保证胶囊常驻
      if (!document.getElementById("dsx-pill")) {
        buildUi();
        diag("悬浮胶囊被页面移除，已自动重建", "bad");
      }
    }, 5000);
  }
  boot();
})();
