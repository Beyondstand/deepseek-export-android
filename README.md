# DeepSeek 会话导出（安卓 App）

在手机上把你在 DeepSeek（chat.deepseek.com）的会话导出为 HTML / TXT 文件。

- App 内嵌 DeepSeek 官网登录页，**在本页正常登录即授权**——不采集账号密码、不读取 DeepSeek 官方 App。
- 会话是账号级同步的：WebView 登录官网即可看到手机上聊的全部会话。
- 登录后页面出现「DS导出」悬浮胶囊（可拖动），展开面板即可导出，文件保存到系统 **Download** 目录并弹确认。

token 只在本机 WebView 内用于同源接口请求，不上传、不落盘；导出的文件保存在你自己手机的下载目录。

## 下载 APK（无需本地安卓环境）

本仓库用 GitHub Actions 自动构建：

1. 打开 **Actions → build-apk → 最新一次绿色运行**；
2. 底部 Artifacts 下载 `app-debug-apk`（zip 里是 `app-debug.apk`）——在 GitHub 页面下载 artifact 需要登录 GitHub 账号；
   命令行等价：`gh run download -R Beyondstand/deepseek-export-android -n app-debug-apk`。

## 安装（侧载 debug 包）

- 把 `app-debug.apk` 传到手机点击安装；
- 系统提示「未知来源 / 安装未知应用」时允许即可（debug 签名，仅自用）；
- MIUI 等国产系统可能还要求开启「未知来源」并登录账号确认，属系统行为；
- **v0.3 起仓库内置固定 debug 签名密钥（`app/debug.keystore`）：之后的新版本 APK 可直接覆盖安装**（不用卸载、不用重新登录）；若手机上还装着更早的 v0.1/v0.2（当时 CI 用的是随机签名），先卸载一次再装 v0.3。

## 使用（当前版本 v0.5）

1. 打开 App → 自动加载 chat.deepseek.com → 正常登录（登录即授权，本 App 不碰账号密码、不读官方 App）；
2. 登录后胶囊圆点变绿；点进任意一个会话（地址变为 /a/…）；
3. 轻点醒目的蓝色「⬇ DS导出」胶囊（长按可拖动）展开面板；
4. 点「📤 导出当前对话」：
   - **Markdown 文件** `DeepSeek_<标题>_<时间戳>.md` 存入手机「下载」目录（页内 + 系统双确认）；
   - 全文同时存进 **App 内「最近导出」**（最多 10 条，localStorage 持久化、放不下自动缩减），点「复制」即得全文 Markdown；「查看」就地展开；
5. 导出成功后面板出现 **「🌐 夸克浏览器」「🤖 通义千问」两个按钮**：点哪个**直接唤起**哪个应用，输入框已带入「接手提示词 + 完整对话 Markdown」，发送即可从原对话接着聊；未安装或应用不接收时自动退回系统分享面板，内容不丢；「最近导出」每条也有「夸克」「千问」快捷链接（重启 App 后按钮条自动恢复最近一次导出）；
6. 「📂 下载目录」跳系统下载界面；「清空」释放 App 内缓存。

### 「夸克 / 千问」接手提示词（已内置，可自行修改）

发给 AI 的文本 = **接手提示词 + 完整对话记录**。提示词要点：让目标 AI 把记录当作**自己的对话记忆**——延续已有话题与进度、记住你的背景/偏好/约束、主动接着解决对话结尾未完成的问题、忠实引用不编造、沿用原语言风格；并注明「👤 用户」是你、「🤖 DeepSeek」是原助手，💭 思考 / 🔍 搜索为辅助内容。

想改提示词：编辑 `app/src/main/assets/dsx_main.js` 顶部的 `QIANWEN_PROMPT` 数组，push 后 Actions 自动出新 APK。

> 直达包名：夸克 `com.quark.browser`、通义 `com.aliyun.tongyi`，写在 `dsx_main.js` 的 `AI_TARGETS`。若点按钮提示「未找到 …，已打开系统分享面板」，说明该应用未安装/未注册接收分享文本；改用「复制」再手动粘贴即可。

诊断：状态行实时显示登录态与最近动作结果；底部徽章 API/已存/失败计数；「诊断日志」可展开——出问题时把内容照抄/截图反馈即可。

> 历史版本 v0.1（骨架自检版，无需登录）的 APK 仍在对应 Actions 运行里可下载，可用于在遇到导出问题时区分「注入/桥接问题」还是「接口问题」：v0.1 的「测试保存」能成功说明注入与保存链路正常。

## 路线图（小步提交，先真机验证再叠加）

- [x] v0.1 工程骨架 + Actions 出 APK + 桥接链路自检
- [x] v0.2 拉取接口，导出**当前对话**（真机验证通过）
- [x] v0.3 只导出 Markdown；全文存 App 内一键复制；胶囊按钮更醒目
- [x] v0.4 把「接手提示词 + 对话全文」分享给千问/夸克
- [x] v0.5 导出后「夸克 / 通义千问」两个按钮**直接唤起**对应应用（未装自动退回分享面板）
- [ ] v0.6 全部会话列表 + 批量导出（页内弹层，逐个或全部）
- [ ] v0.7 在线临时链接（读完即删 Worker）

## 常见问题

- **点导出提示 INVALID_TOKEN / 未登录**：在 App 内的 DeepSeek 页面退出重登一次，再回到会话页导出。
- **Download 里找不到文件**：用面板上的「📂 打开下载目录」，或用文件管理器进入内部存储 Download 目录。
- **导出内容**：Markdown；思考过程为引用块、联网搜索保留「[标题](链接)」。

## 免责

非官方工具，仅用于导出你自己的账号数据；接口来自网页端公开行为，若官方改版可能需要更新脚本。

## 开发

- 单 Activity + WebView，Java，零第三方依赖，minSdk 29 / targetSdk 34；
- `app/src/main/assets/dsx_core.js`：归一化/分支裁剪/Markdown 渲染纯函数（与网页版工具同源），`node tests/dsx_core.test.mjs` 可单测；
- `app/src/main/assets/dsx_main.js`：注入后的悬浮面板、最近导出缓存与原生桥（`window.DSExport`）胶水逻辑，`node tests/dsx_main.smoke.test.mjs` 冒烟；
- `MainActivity.java`：WebView 容器 + 桥：`saveFile`（MediaStore.Downloads）/`copy`（系统剪贴板）/`openDownloads`/`toast`；
- 修改后 push 即触发 Actions 出新 APK。
