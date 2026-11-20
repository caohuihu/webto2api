# 站点适配器修复指南 (Adapter Repair Guide)

本指南总结了 LMArena / DeepSeek / 豆包 三个站点适配器失效的完整修复过程与通用方法，
目的是让**其他网页 AI 站点失效时**可以按图索骥快速修复。

所有站点适配器的共同结构：`src/backend/adapter/<site>_text.js`（文本）与 `<site>.js`（图像），
都基于 Playwright + Camoufox 操作真实浏览器页面。修复的核心是**让选择器、交互方式、
响应解析三样跟上网站改版**，并保证**失败不崩服务**。

---

## 一、调试工作流（重要：单实例测试）

### 1.1 只开要测的实例（避免 3 窗口争抢资源）

改 `data/config.yaml`（gitignore 内，不进仓库）：把其他实例整段注释掉，只留要测的：

```yaml
instances:
  # - name: "browser_default"      # 注释掉
  #   workers:
  #     - name: "default"
  #       type: lmarena
  - name: "browser_deepseek"       # 只留这一个
    userDataMark: "deepseek"
    workers:
      - name: "deepseek"
        type: deepseek_text
```

然后调 `POST /admin/restart`（带 Bearer key）重新加载配置，日志会显示
`正在初始化 1 个 Worker`。测完恢复 3 实例再重启一次。

> 多实例同时开会争抢 CPU，导致浏览器冷启动变慢（曾出现首帧渲染 >60s），
> 排查阶段务必单窗口。

### 1.2 常用端点（key 见 config.yaml 的 server.auth）

| 端点 | 用途 |
| :--- | :--- |
| `GET /admin/status` | 探活；`safeMode.enabled=true` = 全部 Worker 失败 |
| `POST /admin/restart` | 重启子服务（重新读 config.yaml + 重新加载适配器代码） |
| `POST /v1/chat/completions` | 发真实请求验证（`model` 传站点模型 id） |

### 1.3 日志位置

服务是 `supervisor.js`（看门狗）托管 `src/server/server.js`。启动命令
`npm start`（PATH 需前置 Node 24，见第五节）。日志要点：

- `[工作池] [xxx] 初始化完成`：Worker 就绪
- `[适配器] [reqId] [site_text] [model] ...`：请求全流程（新会话 → 输入 → 发送 → 等待 → 完成）
- `ERRO [适配器] ... 生成任务失败`：看 error 字段定位卡在哪一步

### 1.4 登录态失效时

```powershell
npm start -- -login=workerName   # 只起该 Worker 进登录模式，手动登录后保存
```

各实例数据目录隔离：`data/camoufoxUserData`（default）、
`data/camoufoxUserData_deepseek`、`data/camoufoxUserData_doubao`。

---

## 二、常见失效模式与修复方法（通用套路）

### 2.1 网站改版：输入框/按钮选择器失效

**症状**：`未找到输入框`、`元素未找到`。

**方法**：先在**普通浏览器**（或本工具内嵌浏览器）里打开站点，F12 看新 DOM，
再改适配器选择器。本次三个站点的改版快照：

| 站点 | 改版前 | 改版后（当前） |
| :--- | :--- | :--- |
| LMArena | `textarea` | TipTap 富文本 `div[contenteditable="true"]` |
| 豆包 | `textarea` | TipTap `div[contenteditable="true"]`；发送按钮 `button[aria-label="发送"]`（旧 id `#flow-end-msg-send` 保留兜底）；模型菜单项只有 **快速 / 专家**（旧"思考"并入专家） |
| DeepSeek | 旧开关 | 输入框 `textarea[name="search"]`；深度思考/智能搜索为 `div.ds-toggle-button`（中文标签）；模式切换 `div[data-model-type="default\|expert"]` |

**要点**：
- 选择器永远留"新旧双兜底"：`page.locator('button[aria-label="发送"], button#flow-end-msg-send')`
- 模型菜单文案变化时，映射表（如 `MODEL_MENU_MAP`）用正则容错：`/专家|Pro/`
- 上传入口变化：豆包新版为 `#input-engine-container button[aria-haspopup="menu"]`
  中**不带文字**的那个（排除模型/项目/技能按钮），菜单项文案"上传文件或图片"，
  用 `uploadFilesViaChooser`（filechooser 拦截）上传。

### 2.2 SPA 的 load 事件因长连接不触发（导航"超时"）

**症状**：`页面加载超时`，但页面其实已经渲染可用。

**原因**：`gotoWithCheck` 用 `page.goto(url, {waitUntil: 'load'})`，而聊天类 SPA
有 SSE/WebSocket 长连接，`load` 事件经常 20s 内不触发。

**修复**（已应用到 4 个适配器）：改用 `tryGotoWithCheck`，**仅"页面加载超时"视为可继续**，
其他导航错误（HTTP 4xx/5xx、DNS 等）照常抛出：

```js
const navResult = await tryGotoWithCheck(page, TARGET_URL, { timeout: 8000 });
if (navResult.error) {
    if (/页面加载超时/.test(navResult.error)) {
        logger.warn('适配器', '页面加载超时，继续执行 (SPA 长连接属正常现象)', meta);
    } else {
        throw new Error(navResult.error);
    }
}
```

（工具函数在 `src/backend/utils/page.js`：`gotoWithCheck` / `tryGotoWithCheck`。）

### 2.3 首屏渲染慢：输入框等待预算不足

**症状**：`未找到输入框 (Locator)`（goto 已容错后仍失败）。

**方法**：`waitForInput(page, locator, { click: false, timeout: 120000 })`。
多实例 CPU 争抢下冷启动首帧可能 >60s，建议直接给 120s（与 `waitTimeout` 一致）。
预热后（worker 初始化时已连过目标页）请求通常 10~20s 内完成。

### 2.4 拟人化点击 / force 点击超时（CLICK_TIMEOUT）

**症状**：`点击操作失败 (元素): CLICK_TIMEOUT`（25s），尤其**页面局部持续重渲染**时
（如豆包专家模式的思考动画、模型菜单浮层）——`safeClick` 的"元素稳定等待"拿不到
稳定帧；Playwright 原生 `click({force:true})` 也可能在后校验阶段卡 30s。

**修复：关键动作改用 JS 直接派发**（确定性、最快，不依赖可操作性检查）：

```js
// 发送按钮：JS .click() 为主，Playwright 强点兜底
const jsClick = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="发送"], button#flow-end-msg-send');
    if (!btn) return { ok: false, reason: '未找到发送按钮' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true')
        return { ok: false, reason: '按钮处于禁用态' };
    btn.click();
    return { ok: true };
}).catch((e) => ({ ok: false, reason: e.message }));
if (!jsClick.ok) {
    await sendBtn.click({ force: true, timeout: 15000 }).catch(() => { });
}
```

```js
// 输入框聚焦：JS focus（humanType 内部也会 el.focus() 兜底；发送可用 Enter 键）
await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.focus();
}, INPUT_SELECTOR).catch(() => { });
```

**经验**：
- 高频关键动作（发送、聚焦）优先 JS 派发；拟人化轨迹价值在"移动鼠标"，
  对单点点击收益低、抖动成本高。
- 点击前可先 `page.keyboard.press('Escape')` 关掉残留菜单浮层，避免遮挡。
- DeepSeek 发送用 `page.keyboard.press('Enter')`（不依赖按钮），本身最稳。

### 2.5 SSE 响应解析：全量快照里才有最终回答

**症状**：`回复内容为空`（响应其实已完整收到）。

**原因**：新版 DeepSeek SSE 中，短回答（如"收到"）**不会**逐字增量流出，
只出现在**全量快照**事件里：`data: {"p":"response/fragments","v":[{type:"THINK",...},{type:"RESPONSE","content":"收到"}]}`
（注意该事件**没有 `o` 字段**，与 `o:"APPEND"` 的新增片段事件不同）。

**修复**（`deepseek_text.js` 的 `syncFromFragments`）：

```js
// 无 o 的全量快照：权威完整状态，按片段类型重建内容；
// 仅当重建结果比已有累积更长才采用（防早期快照回退 / 防与增量重复）
let resp = '', think = '';
for (const f of frags) {
    if (f.type === 'RESPONSE' && f.content) resp += f.content;
    else if (f.type === 'THINK' && f.content) think += f.content;
}
if (resp.length > textContent.length) textContent = resp;
if (think.length > thinkingContent.length) thinkingContent = think;
```

**SSE 事件分类速查**（DeepSeek 新版）：

| 事件形态 | 含义 |
| :--- | :--- |
| `{"p":"response/fragments/-1/content","o":"APPEND","v":"..."}` | 当前片段内容增量 |
| `{"v":"..."}`（无 p 无 o） | 当前片段内容增量（纯文本 delta） |
| `{"p":"response/fragments","v":[...]}`（**无 o**） | 全量快照，按片段类型重建 |
| `{"p":"response/fragments","o":"APPEND","v":[...]}` | 新增片段（内容需累加） |
| `{"p":"response","o":"BATCH","v":[...]}` 内 `quasi_status:"FINISHED"` | 完成信号 |
| `{"p":"response/status","o":"SET","v":"FINISHED"}` | 完成信号 |

其他站点写 SSE 解析时同理：先抓一次真实响应存下来（日志里 `responseTail` 诊断字段
会打印最近响应原文），按事件类型逐条实现，完成判定用状态字段而非"最后一个 delta"。

### 2.6 崩溃防护：setTimeout reject 造成 unhandled rejection 崩进程

**症状**：请求失败后 ~120s，整个服务进程直接退出（看门狗再拉起 → 崩溃循环，
表现为 camoufox 窗口反复开合、`EADDRINUSE` 3000 端口冲突）。

**原因**：`resultPromise = new Promise((resolve, reject) => { setTimeout(() => reject(超时), 120000); ... })`。
若流程**早期失败**（如点击超时）走 catch 返回，120s 定时器仍会触发 `reject`，
而那时已无人 await 该 Promise → unhandled rejection → Node 崩溃。

**修复**（doubao_text.js，任何类似模式都适用）：

```js
let isResolved = false;
let sseTimeoutId;                 // 提升到外层作用域，可被清理
const resultPromise = new Promise((resolve, reject) => {
    sseTimeoutId = setTimeout(() => {
        if (!isResolved) {
            isResolved = true;
            reject(new Error(`API_TIMEOUT: 响应超时`));
        }
    }, waitTimeout);
    ...                            // 成功路径: isResolved=true; clearTimeout(sseTimeoutId); resolve()
});
// 安全网：resultPromise 可能因早期失败成为"孤儿"，保证它永远被处理过
resultPromise.catch(() => { });
```

**铁律**：任何"带超时的 Promise + 页面监听"模式，超时 reject 必须
(1) 有 `isResolved` 守卫防双 settle；(2) 成功路径 `clearTimeout`；
(3) Promise 创建后立即挂吞异常 catch（至少保证不崩进程）。

---

## 三、崩溃循环（EADDRINUSE + camoufox 秒退）的清理

**症状**：服务反复重启；日志 `EADDRINUSE :::3000`（旧进程还占着）+
`browserType.launchPersistentContext: Target page, context or browser has been closed`
（camoufox 启动即退出，exitCode=0）——残留 camoufox 锁住了 profile 目录。

**清理三连**（直接粘进 PowerShell 窗口执行，**不要**套 `powershell -Command "..."`
外层引号，否则 `$_` 会被吃掉）：

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*supervisor.js*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }
taskkill /F /IM camoufox.exe
```

确认干净后再重启：

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*supervisor.js*' }   # 应无输出
Get-Process camoufox* -ErrorAction SilentlyContinue                                                              # 应无输出
```

然后 `npm start`（PATH 前置 Node 24，见第五节）。

**规律**：3 个 camoufox 实例各产生 ~10 个 OS 进程（Firefox 多进程 + fission 站点隔离），
进程管理器里看到 30 个 camoufox 是**正常**的，不代表残留。

---

## 四、修复一个新站点的标准步骤（checklist）

1. **单实例**：config.yaml 只开目标实例（新站点加一个新 instance + `userDataMark`），
   `/admin/restart`。
2. **登录**：`npm start -- -login=workerName` 完成登录态保存。
3. **摸清 DOM**：普通浏览器 F12 + 本工具内嵌浏览器 `evaluate` 双重确认选择器
   （输入框、发送键、模型/模式菜单、上传入口）。
4. **抓一次真实响应**：先跑通"输入+发送"，看 `responseTail` 诊断打印的响应原文，
   决定是 SSE 增量、全量快照还是轮询。
5. **写解析**：按 2.5 套路实现；完成判定用状态字段。
6. **加固**：
   - goto 换 `tryGotoWithCheck`（2.2）；
   - 输入等待给足预算（2.3）；
   - 关键点击/聚焦用 JS 派发（2.4）；
   - 带超时的 Promise 按 2.6 三铁律加固。
7. **验证**：文本 200；有上传能力的再验图片上传 200；失败路径验"不崩服务"
   （故意发个会失败的场景，看 ~120s 后服务还活着）。
8. **恢复**：config.yaml 恢复全实例，重启，`/admin/status` 确认 `safeMode.enabled=false`
   且 Worker 数正确。

---

## 五、环境注意事项（Windows 原生运行）

| 项 | 说明 |
| :--- | :--- |
| Node | 必须 **24 LTS**（`C:\Users\caohuihu\AppData\Local\Temp\opencode\node24\node-v24.22.3-win-x64`，重启电脑会丢，建议装 nvm 固化）。better-sqlite3 没有 Node 26 预编译且本机无 VS Build Tools。 |
| 启动 | `npm start` 前 PATH 前置 node24 目录 |
| Camoufox 资源 | `camoufox/` 目录（~505MB）经 gh-proxy.com 镜像 + curl 断点续传下载 |
| GeoLite2 | `src/backend/geoip/mmdb`，曾坏为"Invalid Extended Type at offset 0 val 7"，重下修复 |
| pnpm | `pnpm-workspace.yaml` 需 allowBuilds 放行 better-sqlite3 / sharp（已提交） |
| 配置 | `data/config.yaml` 在 gitignore，**不进仓库**（密钥与登录态不外泄） |

---

## 六、当前各站点选择器快照（2026-11-20 验证）

| 站点 | 输入框 | 发送 | 模式/模型 | 上传 |
| :--- | :--- | :--- | :--- | :--- |
| LMArena (arena.ai) | `div[contenteditable="true"]`（TipTap） | 按该站 UI | 模型 id 直传（134 个模型池） | 图像生成场景 |
| DeepSeek (chat.deepseek.com) | `textarea[name="search"]` | `Enter` 键 | `div[data-model-type]`；`div.ds-toggle-button`（思考/搜索） | 粘贴/filechooser，最多 20 个单 100MB |
| 豆包 (doubao.com) | `div[contenteditable="true"]`（TipTap） | `button[aria-label="发送"]`（JS .click()） | 菜单仅 **快速(seed) / 专家(seed-pro、seed-thinking)**；按钮文案即当前模式 | `#input-engine-container` 无文字 menu 按钮 → "上传文件或图片"（filechooser） |

> 网站再次改版时，从上表出发用 F12 对比即可，无需重读全部源码。
