/* dsx_main.js 冒烟测试（v0.7）：vm 里搭最小 DOM/原生桥/接口桩。
 * 覆盖：导出 MD → 复制并打开（小对话=完整纯文本；大对话=精简接手包防剪贴板卡顿）。
 * 运行：node tests/dsx_main.smoke.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const DSExp = require("../app/src/main/assets/dsx_core.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 最小 DOM 桩 ---------------- */
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.textContent = "";
    this.parentNode = null;
    this.handlers = {};
    // 模拟真实 DOM：cssText 赋值会把 k:v; 声明解析成 style 上的 camelCase 属性
    const styleObj = {};
    Object.defineProperty(styleObj, "cssText", {
      set(v) {
        for (const k of Object.keys(this)) delete this[k];
        String(v).split(";").forEach((d) => {
          const i = d.indexOf(":");
          if (i > 0) {
            const key = d.slice(0, i).trim().replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            this[key] = d.slice(i + 1).trim();
          }
        });
        this._cssText = String(v);
      },
      get() { return this._cssText || ""; },
    });
    this.style = styleObj;
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  get offsetWidth() { return 60; }
  get offsetHeight() { return 24; }
}
const allElements = [];
function findId(rootEl, id) {
  for (const c of rootEl.children || []) {
    if (c.id === id) return c;
    const r = c.children ? findId(c, id) : null;
    if (r) return r;
  }
  return null;
}
const body = new FakeElement("body");
const document = {
  body,
  createElement(tag) { const e = new FakeElement(tag); allElements.push(e); return e; },
  createTextNode(t) { return { textContent: t, parentNode: null }; },
  getElementById(id) { return findId(body, id); },
};

/* ---------------- localStorage 桩（已登录） ---------------- */
const store = new Map([["userToken", JSON.stringify({ value: "fake-token" })]]);
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

/* ---------------- 原生桥桩（与真实桥方法一一对应） ---------------- */
const saves = [];
const copies = [];
const opened = [];
const DSExport = {
  version: () => "0.7-test",
  saveFile(name, mime, content) {
    saves.push({ name, mime, content });
    return JSON.stringify({ ok: true, name, path: "Download/" + name, size: content.length });
  },
  openDownloads() {},
  toast() {},
  copy(text) { copies.push(text); },
  openApp(pkg) { opened.push(pkg); },
};

/* ---------------- 接口桩（与已验证的包络一致） ---------------- */
const MSGS = [
  { message_id: 1, parent_id: null, role: "USER", inserted_at: 1, fragments: [{ type: "REQUEST", content: "你好" }] },
  { message_id: 2, parent_id: 1, role: "ASSISTANT", inserted_at: 2, fragments: [{ type: "THINK", content: "旧思考" }, { type: "RESPONSE", content: "被重新生成的旧回答" }] },
  { message_id: 3, parent_id: 1, role: "ASSISTANT", inserted_at: 3, fragments: [{ type: "THINK", content: "当前思考" }, { type: "RESPONSE", content: "正式回答" }] },
  { message_id: 4, parent_id: 3, role: "USER", inserted_at: 4, fragments: [{ type: "REQUEST", content: "继续" }] },
  { message_id: 5, parent_id: 4, role: "ASSISTANT", inserted_at: 5, fragments: [
    { type: "TOOL_SEARCH", queries: ["q"], results: [{ title: "t", url: "u" }] },
    { type: "RESPONSE", content: "最终回答" },
  ] },
];
const OK_SMALL = () => ({
  code: 0, msg: "",
  data: { biz_code: 0, biz_data: {
    chat_session: { id: "smoke-1", title: "测试会话", current_message_id: 5, model_type: "chat" },
    chat_messages: MSGS,
  } },
});
const BIG_TEXT = "BIGDATA_" + "正".repeat(118000) + "_ENDMARK";
const OK_BIG = () => ({
  code: 0, msg: "",
  data: { biz_code: 0, biz_data: {
    chat_session: { id: "smoke-2", title: "超大对话", current_message_id: 2 },
    chat_messages: [
      { message_id: 1, parent_id: null, role: "USER", inserted_at: 1, fragments: [{ type: "REQUEST", content: "长对话开始" }] },
      { message_id: 2, parent_id: 1, role: "ASSISTANT", inserted_at: 2, fragments: [{ type: "RESPONSE", content: BIG_TEXT }] },
    ],
  } },
});
const box = { envelope: OK_SMALL() };
let fetchCalls = 0;
const fetchStub = () => {
  fetchCalls++;
  return Promise.resolve({ json: () => Promise.resolve(box.envelope) });
};

/* ---------------- 装载 dsx_main.js ---------------- */
const sandbox = {
  DSExp, DSExport,
  console,
  setTimeout, setInterval, clearTimeout, clearInterval,
  localStorage, document,
  location: { pathname: "/a/chat/s/smoke-session-1" },
  innerWidth: 390, innerHeight: 800,
  fetch: fetchStub,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(path.join(ROOT, "app/src/main/assets/dsx_main.js"), "utf8"),
  sandbox,
  { filename: "dsx_main.js" },
);

const exportBtn = () => allElements.find((e) => e.textContent === "📤 导出当前对话");
const btnByText = (t) => allElements.find((e) => e.textContent === t);

/* ---------------- 断言 ---------------- */
await sleep(120); // boot + 首帧

assert.ok(document.getElementById("dsx-pill"), "悬浮胶囊已注入");
assert.ok(document.getElementById("dsx-sheet"), "底部面板已注入");
assert.ok(exportBtn(), "「导出当前对话」按钮存在");
const quarkBtn0 = btnByText("🌐 夸克浏览器");
const tongyiBtn0 = btnByText("🤖 通义千问");
assert.ok(quarkBtn0 && tongyiBtn0, "两个「复制并打开」按钮存在");
const strip = quarkBtn0.parentNode.parentNode;
assert.equal(strip.style.display, "none", "导出前按钮条隐藏");

// 1) 小对话导出 → MD 文件 + 缓存（MD/纯文本/精简包三份）+ 按钮条出现
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 1, "发起 1 次接口请求");
assert.equal(saves.length, 1, "经原生桥保存 1 个文件");
assert.match(saves[0].name, /^DeepSeek_测试会话_\d{8}-\d{6}\.md$/, "文件仍为 Markdown");
assert.ok(saves[0].content.includes("最终回答"), "MD 含当前分支内容");
assert.ok(!saves[0].content.includes("被重新生成的旧回答"), "MD 不含被裁剪的旧分支");
const cached = JSON.parse(store.get("dsx_exports"));
assert.equal(cached.length, 1, "缓存 1 条");
assert.ok(cached[0].plain && cached[0].plain.includes("【用户】"), "缓存含纯文本版");
assert.ok(cached[0].digest && cached[0].digest.includes("精简接手包"), "缓存含精简接手包");
assert.equal(strip.style.display, "block", "导出后按钮条显示");
let toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl && toastEl.textContent.includes("已导出"), "页内确认 toast");
assert.ok(allElements.some((e) => e.textContent === "API 1 · 已存 1 · 失败 0"), "计数徽章更新");

// 2) 小对话 → 点「夸克浏览器」= 复制完整纯文本 + 打开
quarkBtn0.onclick();
assert.equal(copies.length, 1, "复制提示词+全文");
assert.ok(copies[0].startsWith("我想让你「接手」一段我和另一个 AI 助手（DeepSeek）的对话。"),
  "复制文本以接手提示词开头");
assert.ok(copies[0].includes("（以下为对话记录）"), "提示词与正文分隔");
assert.ok(copies[0].includes("【用户】") && copies[0].includes("【DeepSeek】"), "纯文本记录标记");
assert.ok(!copies[0].includes("## ") && !copies[0].includes("> 💭"), "不含 Markdown 记号");
assert.ok(copies[0].includes("最终回答"), "全文完整");
assert.ok(!copies[0].includes("精简接手包"), "小对话走完整模式");
assert.equal(opened.length, 1, "调用原生打开应用");
assert.equal(opened[0], "com.quark.browser", "目标为夸克浏览器包名");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("粘贴"), "提示去目标应用粘贴");
assert.equal(fetchCalls, 1, "未重复拉接口");

// 3) 小对话 → 通义千问 + 条目快捷链接
tongyiBtn0.onclick();
assert.equal(copies.length, 2);
assert.equal(opened[1], "com.aliyun.tongyi", "目标为通义千问包名");
const copyBtn = btnByText("复制");
copyBtn.onclick();
assert.equal(copies[2], saves[0].content, "条目「复制」仍是 MD 全文（笔记用）");
const viewBtn = btnByText("查看");
viewBtn.onclick();
assert.equal(viewBtn.parentNode.parentNode.children[1].style.display, "block", "查看展开内容");
const ftQuark = btnByText("夸克");
ftQuark.onclick();
assert.equal(opened[2], "com.quark.browser");
assert.equal(fetchCalls, 1, "全程只拉过 1 次接口");

// 4) INVALID_TOKEN → 明确提示，不落文件不复制不打开
box.envelope = { code: 40003, msg: "INVALID_TOKEN", data: { biz_code: 40003, biz_data: null } };
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 1, "失败时不产生新文件");
assert.equal(copies.length, 4, "失败时不复制");
assert.equal(opened.length, 3, "失败时不打开应用");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("登录已失效"), "INVALID_TOKEN 有明确提示");

// 5) 大对话导出 → 喂 AI 自动改发精简接手包（防剪贴板卡顿）
box.envelope = OK_BIG();
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 3, "含失效请求共 3 次接口调用");
assert.equal(saves.length, 2, "大对话仍导出完整 .md");
assert.ok(saves[1].content.length > 100000, "MD 文件为完整内容");
const cached2 = JSON.parse(store.get("dsx_exports"));
assert.equal(cached2.length, 2, "缓存 2 条");
assert.equal(cached2[0].name, saves[1].name, "最新在前");
assert.ok(cached2[0].len > 80000, "缓存条目标记为大对话");
const qk = btnByText("🌐 夸克浏览器");
qk.onclick();
const feedText = copies[4];
assert.ok(feedText.length < 20000, "剪贴板只放精简包（原 11 万字符）");
assert.ok(feedText.includes("精简接手包"), "走精简模式");
assert.ok(feedText.includes("BIGDATA_"), "包含最新消息开头");
assert.ok(!feedText.includes("ENDMARK"), "超长正文被截断");
assert.ok(feedText.includes("最近") && feedText.includes("完整记录"), "说明更早内容在文件里");
assert.equal(opened[3], "com.quark.browser", "仍直接唤起夸克");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("精简接手包"), "精简模式确认提示");
assert.ok(allElements.some((e) => e.textContent === "API 3 · 已存 2 · 失败 1"), "最终计数徽章");
assert.ok(allElements.some((e) => (e.textContent || "").includes("大（发精简包）")),
  "列表条目标注大对话");

console.log("✅ dsx_main.js 冒烟测试通过（MD导出/复制并打开/大对话自动精简包/无效token）");
process.exit(0);
