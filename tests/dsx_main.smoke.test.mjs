/* dsx_main.js 冒烟测试（v0.9）：vm 里搭最小 DOM/原生桥/接口桩。
 * 覆盖：导出 MD → 三渠道（夸克/通义/元宝）格子接力（自动取下一格）→
 * Jupyter 式格子列表（状态/单独复制/展开）→ 重置 → INVALID_TOKEN 分支。
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
    this.parentNode = null;
    this.handlers = {};
    // 与真实 DOM 一致：设置 textContent 会清空子节点
    const self = this;
    Object.defineProperty(this, "textContent", {
      configurable: true,
      get() { return self._text || ""; },
      set(v) {
        self._text = String(v == null ? "" : v);
        self.children = [];
      },
    });
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
  version: () => "0.9-test",
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
const yuanbaoBtn0 = btnByText("🐧 腾讯元宝");
assert.ok(quarkBtn0 && tongyiBtn0 && yuanbaoBtn0, "三个渠道按钮存在");
const strip = quarkBtn0.parentNode.parentNode;
assert.equal(strip.style.display, "none", "导出前按钮条隐藏");

// 1) 小对话导出 → 1 格（全文+提示词同格）
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 1, "发起 1 次接口请求");
assert.equal(saves.length, 1, "经原生桥保存 1 个文件");
assert.match(saves[0].name, /^DeepSeek_测试会话_\d{8}-\d{6}\.md$/, "文件仍为 Markdown");
assert.ok(saves[0].content.includes("最终回答"), "MD 含当前分支内容");
assert.ok(!saves[0].content.includes("被重新生成的旧回答"), "MD 不含被裁剪的旧分支");
const cached = JSON.parse(store.get("dsx_exports"));
assert.equal(cached.length, 1, "缓存 1 条");
assert.equal(cached[0].units.length, 1, "小对话只有 1 格");
assert.deepEqual(cached[0].copied, [], "初始无已复制格");
assert.equal(strip.style.display, "block", "导出后按钮条显示");
const cellsBox = strip.children[3];
assert.equal(cellsBox.children.length, 1, "格子列表 1 格");
let toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl && toastEl.textContent.includes("已导出"), "页内确认 toast");
assert.ok(allElements.some((e) => e.textContent === "API 1 · 已存 1 · 失败 0"), "计数徽章更新");

// 2) 小对话 → 夸克 = 复制第 1/1 格（完整纯文本）+ 打开
quarkBtn0.onclick();
assert.equal(copies.length, 1, "复制提示词+全文");
assert.ok(copies[0].startsWith("我想让你「接手」一段我和另一个 AI 助手（DeepSeek）的对话。"),
  "复制文本以接手提示词开头");
assert.ok(copies[0].includes("下面是完整的对话记录（纯文本格式）"), "单格用完整引言");
assert.ok(copies[0].includes("【用户】") && copies[0].includes("【DeepSeek】"), "纯文本记录标记");
assert.ok(!copies[0].includes("## ") && !copies[0].includes("> 💭"), "不含 Markdown 记号");
assert.ok(copies[0].includes("最终回答"), "全文完整");
assert.equal(opened.length, 1, "调用原生打开应用");
assert.equal(opened[0], "com.quark.browser", "目标为夸克浏览器包名");
assert.equal(JSON.parse(store.get("dsx_exports"))[0].copied[0], true, "格子标记已复制");
assert.equal(cellsBox.children[0].style.cssText.includes("#22c55e"), true, "复制后格子变绿");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("粘贴"), "提示去目标应用粘贴");
assert.equal(fetchCalls, 1, "未重复拉接口");

// 3) 小对话已发完 → 通义按钮 = 提示全部完毕，不重复复制，仍打开应用
tongyiBtn0.onclick();
assert.equal(copies.length, 1, "全部完毕后不重复复制");
assert.equal(opened.length, 2, "仍打开应用继续聊");
assert.equal(opened[1], "com.aliyun.tongyi", "目标为通义千问包名");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("发送完毕"), "全部完毕提示");

// 4) INVALID_TOKEN → 明确提示，不落文件不复制不打开
box.envelope = { code: 40003, msg: "INVALID_TOKEN", data: { biz_code: 40003, biz_data: null } };
exportBtn().onclick();
await sleep(200);
assert.equal(saves.length, 1, "失败时不产生新文件");
assert.equal(copies.length, 1, "失败时不复制");
assert.equal(opened.length, 2, "失败时不打开应用");
toastEl = document.getElementById("dsx-toast");
assert.ok(toastEl.textContent.includes("登录已失效"), "INVALID_TOKEN 有明确提示");

// 5) 大对话导出 → 自动分多格（>=10 格），进度归零
box.envelope = OK_BIG();
exportBtn().onclick();
await sleep(200);
assert.equal(fetchCalls, 3, "含失效请求共 3 次接口调用");
assert.equal(saves.length, 2, "大对话仍导出完整 .md");
assert.ok(saves[1].content.length > 100000, "MD 文件为完整内容");
const cached2 = JSON.parse(store.get("dsx_exports"));
assert.equal(cached2.length, 2, "缓存 2 条");
assert.equal(cached2[0].name, saves[1].name, "最新在前");
assert.ok(cached2[0].len > 80000, "大对话条目");
assert.ok(cached2[0].units.length >= 10, "大对话自动拆多格");
assert.deepEqual(cached2[0].copied, [], "新导出格子未复制");
const unitLabelEl = strip.children[2].children[0];
assert.ok(unitLabelEl.textContent.includes("已复制 0/"), "进度归零");

// 6) 渠道按钮自动取下一格：夸克→格1，通义→格2，元宝→格3
quarkBtn0.onclick();
const unit1 = copies[1];
assert.ok(unit1.includes("将分") && unit1.includes("此为第 1/"), "首格带分段说明");
assert.ok(unit1.includes("长对话开始"), "第 1 格从会话开头开始");
assert.ok(!unit1.includes("ENDMARK"), "末尾内容不在第 1 格");
assert.equal(opened[2], "com.quark.browser", "仍直接唤起夸克");
tongyiBtn0.onclick();
const unit2 = copies[2];
assert.ok(unit2.includes("第 2/") && unit2.includes("紧接上一条消息"), "第 2 格带接续说明");
assert.ok(unit2.includes("BIGDATA_"), "第 2 格进入超长消息");
assert.equal(opened[3], "com.aliyun.tongyi", "通义渠道");
yuanbaoBtn0.onclick();
const unit3 = copies[3];
assert.ok(unit3.includes("第 3/"), "元宝渠道取第 3 格");
assert.equal(opened[4], "com.tencent.hunyuan.app.chat", "元宝包名正确");
assert.equal(fetchCalls, 3, "分段不重新拉接口");
assert.ok(unitLabelEl.textContent.includes("已复制 3/"), "进度 3/N");

// 7) 格子列表：单格复制 + 状态
const cellCopy = cellsBox.children[0].children[0].children[2];
cellCopy.onclick();
assert.equal(copies.length, 5, "格子单独复制");
assert.ok(copies[4].includes("此为第 1/"), "单格复制内容正确");
assert.equal(JSON.parse(store.get("dsx_exports"))[0].copied[0], true, "首格已复制");

// 8) 一路点夸克取完剩余格 → 末段尾注 → 全部完毕
let guard = 0;
while (guard++ < 100) {
  const item = JSON.parse(store.get("dsx_exports"))[0];
  const done = item.copied.filter(Boolean).length;
  if (done >= item.units.length) break;
  quarkBtn0.onclick();
}
const finalItem = JSON.parse(store.get("dsx_exports"))[0];
assert.equal(finalItem.copied.filter(Boolean).length, finalItem.units.length, "全部格子已复制");
const lastUnit = copies[copies.length - 1];
assert.ok(lastUnit.includes("发送完毕"), "最后一格带完毕尾注");
assert.ok(lastUnit.includes("ENDMARK"), "末格含对话结尾");
assert.equal(JSON.parse(store.get("dsx_exports"))[0].copied.filter(Boolean).length,
  JSON.parse(store.get("dsx_exports"))[0].units.length, "末格复制后标记完成");

// 9) 重置 → 清零，可重新开始
btnByText("↺ 重置").onclick();
assert.deepEqual(JSON.parse(store.get("dsx_exports"))[0].copied, [], "重置后清零");
quarkBtn0.onclick();
const restartUnit = copies[copies.length - 1];
assert.ok(restartUnit.includes("此为第 1/"), "重置后从第 1 格重来");
assert.ok(allElements.some((e) => e.textContent === "API 3 · 已存 2 · 失败 1"), "最终计数徽章");
assert.ok(allElements.some((e) => (e.textContent || "").includes(" 格")), "列表条目标注格数");

console.log("✅ dsx_main.js 冒烟测试通过（MD导出/三渠道格子接力/单格复制/重置/无效token）");
process.exit(0);
