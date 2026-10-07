# fingerprint-browser (skeleton)

多账号反检测浏览器的**双引擎骨架**：所有引擎挂在同一个 `InjectionHost` 接口后面，
用一套自检跑分脚本对比它们的实际表现。

架构从第一天就是终态形状 —— 新增一个引擎 = 新增一个实现类，不动上层。

```
profile / proxy / fingerprint engine  ──►  InjectionHost  ──►  Playwright API
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          ▼                                             ▼
                 chrome-lite (产品主线)                        camoufox (参照/兜底)
        Chromium + patchright(自动化泄漏补丁)              Firefox fork，C++ 层指纹注入
        + 本仓库 JS 指纹 init script                       (身份由 fpgen 生成)
```

## 为什么这样能最大化复用开源资源

`patchright` 与 `@camoufox/camoufox` **都说 Playwright 的 API**。因此：

- 自动化泄漏层：直接 `patchright` drop-in（跟上游 release）
- 内核级指纹：需要时切到 `camoufox`（同一个接口，几乎零改造成本）
- 指纹画像：可接 `scrapfly/fingerprint-generator`（`generateFingerprint` 的升级位）
- TLS 层（未来）：`curl_cffi` / `uTLS`，同样作为 host 的一个能力

## 目录

```
src/
├── core/
│   ├── config.ts               # 路径/数据目录
│   ├── logger.ts
│   ├── fingerprint/
│   │   ├── types.ts            # Fingerprint 模型
│   │   ├── seed.ts             # 确定性生成（同 id → 同指纹）
│   │   ├── consistency.ts      # 自洽性校验（CI 门禁的雏形）
│   │   └── inject.ts           # ★ Chromium 侧注入脚本（要持续加固的那层）
│   ├── proxy/
│   │   ├── types.ts            # 代理 + geo 一致性
│   │   └── store.ts            # 代理库（可复用、可绑定）
│   ├── profile/
│   │   ├── types.ts
│   │   └── store.ts            # profile CRUD（JSON，可换 SQLite）
│   └── session/manager.ts      # 运行中的浏览器会话（启动/停止/追踪）
├── hosts/
│   ├── types.ts                # ★ InjectionHost 接口
│   ├── registry.ts
│   ├── chrome-lite/index.ts    # patchright 引擎
│   └── camoufox/index.ts       # camoufox 适配
├── server/index.ts             # 本地 HTTP API + 静态控制台
└── check/
    ├── targets.ts              # 检测站列表
    ├── local-server.ts         # 自检用本地 HTTP 页
    ├── runner.ts               # 信号采集（主世界）+ 一致性评分
    └── service.ts              # runEngineCheck（CLI 与 API 共用）
ui/                             # 无构建步骤的 Web 控制台（SPA）
electron/                       # Electron 桌面壳（main/preload + builder 配置）
scripts/check.ts                # 跑分入口
test/                           # 逻辑/API/集成测试
```

## 安装

```bash
npm install
# 下载 patchright 的 Chromium（必须）
npx patchright install chromium
# 可选：Camoufox 引擎
npm i @camoufox/camoufox
```

> 注意：Playwright/patchright 的浏览器是 **glibc** 构建。若在 Alpine/musl 上跑，
> 需要 glibc 兼容层或改用 glibc 的发行版/容器；开发机（macOS/Windows/Ubuntu）无此问题。

## 使用

```bash
# 看引擎能力与可用性
npm run cli -- engines

# 建 profile（可带代理 + 国家，自动对齐时区/语言）
npm run cli -- profiles:create --name shop-us --os windows --proxy-server http://1.2.3.4:8080 --proxy-country US

npm run cli -- profiles:list

# 启动（默认有头；反检测不要用 headless）
npm run cli -- launch shop-us --url https://bot.sannysoft.com/

# 自检跑分：单引擎 / 双引擎对比 / 只跑一致性不联网
npm run check -- --profile shop-us
npm run check -- --all-engines --headed --json
npm run check -- --all-engines --no-sites

# CI 门禁：低于阈值则进程退出非零
npm run check -- --engine chrome-lite --headed --no-sites --min-score 100
```

报告输出到 `data/reports/<时间>_<引擎>_<profile>/`，含 `report.json` 与各检测站截图。

## Web 控制台（产品）

```bash
npm run serve            # 默认 http://127.0.0.1:8787
# 浏览器打开上面的地址
```

控制台提供：
- **Profiles**：新建/编辑/删除、启动/停止浏览器、一键自检、运行状态、**搜索 + 文件夹过滤**
- **文件夹 / 分组**：给 profile 归类，按文件夹筛选
- **批量操作**：多选后批量 启动 / 停止 / 删除 / 移动到文件夹
- **批量创建**：按名称模板（`profile-{n}`）一次生成多个
- **复制 / 导入 / 导出**：profile 配置可导出 JSON、导入重建（含 folder/status/overrides）
- **Cookie 导入 / 导出**：按 profile 读写浏览器 cookie（JSON）
- **书签导入 / 导出**：读写 Chromium profile 的 `Default/Bookmarks`
- **扩展加载**：按 profile 指定解包扩展目录（`--load-extension`）
- **拟人输入**：对运行中的 profile 逐字输入（随机键间隔，对应 "paste as human typing"）
- **动作同步器**：命令级同步（type/goto/click/scroll）到多个运行中 profile
- **实时输入镜像**：以某 profile 为 leader，捕获其鼠标/键盘/滚轮事件并实时回放到 follower（多窗口同步器）
- **移动指纹**：OS 支持 Windows/macOS/Linux/**Android/iOS**（UA、platform、UA-CH、触摸点、移动分辨率/GPU）
- **内核切换**：每个 profile 可选引擎（chrome-lite ≈ SunBrowser，camoufox ≈ FlowerBrowser）
- **标签 / 备注 / 状态**：给 profile 打标签、写备注、设状态
- **Proxy library**：代理的增删与绑定（`country` 驱动指纹 geo 对齐）；**代理密码 AES-256-GCM 落盘加密**；**导入/导出 + 连通性检测（TCP）**
- **团队 / 角色 / 权限**：admin / operator / viewer 三种角色，按用户 token 鉴权（也可用单个 `FB_TOKEN`）
- **TOTP 2FA**：RFC 6238 真·两步验证；开启后登录需 token+验证码，服务端签发 12h 会话令牌
- **Engines**：两个引擎的能力与可用性
- **Settings**：默认引擎/默认 OS/默认代理/默认 headless
- **Activity**：操作日志（最近 1000 条）
- **Audit tools**：Sannysoft / CreepJS / Pixelscan / BrowserLeaks / BrowserScan / Fingerprint Checker / DNS leak 一键直达

本地 HTTP API（前端与控制台都走它，也是后续自动化/外部的入口）：

```
GET    /api/health
GET    /api/engines
GET    /api/profiles            POST /api/profiles
POST   /api/profiles/batch      # 批量创建
POST   /api/profiles/bulk       # 批量 launch|stop|delete
POST   /api/profiles/:id/duplicate
GET    /api/profiles/:id        PATCH /api/profiles/:id
DELETE /api/profiles/:id
POST   /api/profiles/:id/launch        POST /api/profiles/:id/stop
POST   /api/profiles/:id/check
GET    /api/profiles/:id/cookies       POST /api/profiles/:id/cookies
POST   /api/profiles/:id/type
POST   /api/profiles/:id/eval
GET    /api/profiles/:id/bookmarks     POST /api/profiles/:id/bookmarks
POST   /api/sync                # 命令级同步（type|goto|click|scroll）
GET    /api/sync                POST /api/sync/start     POST /api/sync/stop
GET    /api/proxies             POST /api/proxies
GET    /api/proxies/export      POST /api/proxies/import
POST   /api/proxies/:id/test
PATCH  /api/proxies/:id         DELETE /api/proxies/:id
GET    /api/sessions            POST /api/sessions/:id/close
GET    /api/settings            PATCH /api/settings
GET    /api/export              POST /api/import
GET    /api/activity            DELETE /api/activity
GET    /api/me
GET    /api/users               POST /api/users        DELETE /api/users/:id
POST   /api/auth/login          POST /api/auth/logout
POST   /api/auth/totp/setup     POST /api/auth/totp/enable   POST /api/auth/totp/disable
```

> 功能点参照了 **GoLogin / Incogniton 官方 features 页** 与 **AdsPower 官网首页**、
> **Multilogin 官网** 的公开清单（多 profile 管理、分组、批量操作、导入导出、cookie、
> 团队/权限、代理、RPA/同步器、云/云手机、审计、加密、2FA 等）。已实现为本地、无外部依赖
> 的部分；团队/云/代理资源/行为模拟/内核选择等留待后续。

CLI（无 GUI 时的等价操作）：

```bash
npm run cli -- engines
npm run cli -- proxies:add --server http://ip:port --name p1 --country US
npm run cli -- proxies:list
npm run cli -- profiles:create --name shop --os windows --proxy-id <proxyId>
npm run cli -- profiles:update <id> --name shop2
npm run cli -- profiles:delete <id>
npm run cli -- launch shop
npm run serve
```

## 桌面 App（Electron）

Electron 只做**外壳**：主进程内嵌我们的 core（`startServer`），窗口加载本地控制台；
真正的指纹浏览器仍是 core **单独 spawn** 的进程（patchright Chromium / Camoufox）。

```bash
npm run make:icon       # 生成 build/icon.png（无依赖）
npm run electron:dev    # 构建 bundle 并以桌面窗口启动
npm run dist:win        # Windows 安装包（NSIS + portable）—— 在 Windows 上运行
npm run dist            # 当前平台打包（Linux AppImage / macOS dmg）
```

**首次运行引导**：控制台在 `settings.onboarded=false` 时弹出三步向导
（引擎可用性 + 一键安装 / 默认引擎与 OS / 创建首个 profile）。

**打包要点**
- `FB_ROOT=resources`（放 `ui/`）、`FB_DATA_DIR=<userData>/data`（可写）、
  内核二进制走 `resources/browsers` + `PLAYWRIGHT_BROWSERS_PATH`
- 图标：`build/icon.png`（1024²），electron-builder 自动转 ico/icns
- 引擎安装：`POST /api/engines/:name/install`（`patchright install chromium` / `camoufox fetch`）

**平台差异**
- **Windows：必须在 Windows 上打包**。Linux 交叉构建 Windows 需要 wine
  （electron-builder 要改写 exe 资源），本项目环境没有 wine。
  在 Windows 上：`npm ci && npm run dist:win` → `release/*.exe`
- Linux：`npm run dist -- --linux AppImage`（已验证 unpacked 可启动）
- macOS：在 macOS 上 `npm run dist -- --mac`

**强烈建议预置内核**（否则首次运行要下载）：
```bash
# 在目标平台、打包前：
PLAYWRIGHT_BROWSERS_PATH=./browser-dist npx patchright install chromium
# electron-builder.yml 已预留 browser-dist -> browsers 的 extraResources
```

## 在线构建（GitHub Actions，推荐）

因为 Windows/macOS 安装包必须在对应系统上打，用 CI 的原生 runner 最省事。
仓库已带 `.github/workflows/build.yml`：矩阵 `windows-latest`(x64) + `macos-14`(Apple Silicon)，
自动 `npm ci` → 测试 → 预置 Chromium → 打包 → 上传 artifact。

**用法**：推到 GitHub 后，在 Actions 里手动跑 `desktop-build`，或打 tag：
```bash
git tag v0.1.0 && git push origin v0.1.0
```
产物：`windows-x64`（`.exe` NSIS/portable）、`macos-arm64`（`.dmg`/`.zip`）。

**签名（发行时才需要）**
- Windows：需 Authenticode 证书，否则 SmartScreen 会警告
- macOS：**分发必须** Apple Developer ID 签名 + 公证（notarize），否则 Gatekeeper 拦截；
  CI 里默认 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名（测试用），自测时可右键打开或
  `xattr -cr /Applications/FingerprintBrowser.app`

> 目标客户是 x86 Windows 与 M 系列 Mac，本 CI 矩阵正好覆盖：Windows 出 x64，
> macOS 在 arm64 runner 上原生出 arm64。

> 两套 Chromium 会共存：Electron 自带的（只渲染 UI）+ 指纹内核用的。这是"外壳不碰指纹内核"的代价，
> 换来的是内核可控、可升级、可做内核级注入。

## 测试

```bash
npm run typecheck          # TS 类型检查（含 electron/）
npm test                   # 无浏览器：逻辑 + API + 静态 UI（74+9 项）
npm run test:integration   # 需要浏览器（xvfb）：持久化/隔离 + 启动/停止 + 拟人输入 + 同步 + 镜像 + cookie
npm run electron:build     # 构建 Electron bundle
```

测试不依赖外部资源（检测站/代理）；只验证代码正确性与"能正常启动"。

## 自检是怎么读指纹的（重要）

`chrome-lite` 的自检**不做 `page.evaluate` 读 `navigator`**，原因有三个，都经过实测：

1. **patchright 的 `page.evaluate` 跑在隔离世界（isolated world）**。它故意避免
   `Runtime.enable`，于是自动化代码在隔离上下文执行。你覆盖在**主世界**的
   `navigator.platform` / WebGL 等，隔离世界根本看不到 —— 早期自检因此误报 67/100。
2. **patchright 的 init script 通过「网络路由」注入**，只对 HTTP(S) 响应生效。
   `about:blank` / `data:` / `file:` 不会注入；且 `about:blank` 不是安全上下文，
   `navigator.userAgentData` 缺失。
3. **原始 CDP `Page.addScriptToEvaluateOnNewDocument` 被 patchright 中和**，不生效。

因此自检的做法是：
- 起一个 **127.0.0.1 的本地 HTTP 页**（安全上下文、真实响应）；
- 用一个 **主世界 init script** 采集信号并写入 `<html data-fb-signals="...">`；
- 再从 DOM 属性读回 —— DOM 跨世界共享，绕开隔离世界。

> 这也意味着：**真实网站在主世界看到的是被覆盖后的指纹**；只要自检按主世界读，分数才有意义。

## 无 GPU 环境（CI / 容器 / NAS）

Chrome 137+ 默认禁止软件 WebGL，无 GPU 时 `getContext('webgl')` 返回 `null`——
这本身就是强指纹信号。`chrome-lite` 默认加了 `--enable-unsafe-swiftshader` 打开
软件 WebGL（有 GPU 时是无害的 no-op），随后由注入脚本覆盖 vendor/renderer。

## ARM 测试结论（NAS / Ubuntu 24.04 / arm64）

- 类型检查、逻辑测试、CLI、chrome-lite 主世界自检全部通过
- **signalScore 100/100**（Windows→`Win32`、macOS→`MacIntel` 均一致）
- **profile 持久化/隔离集成测试通过**：cookie + localStorage 重开后保留，指纹跨会话不漂移，
  不同 profile 互不可见
- 修复了「隔离世界误读」与「本地 HTTP 服务器 keep-alive 导致任务卡 12 分钟」两个 bug
- **Camoufox 在 ARM 上已跑通**（`CAMOUFOX_OK`）：Firefox 152，主世界信号可采集
- 外部检测站仍未验收，需在 x86 WSL 复测

### Camoufox 在 ARM 的环境要求（重要）

Camoufox 首次使用会下载约 **1.28 GB** 的 Firefox 构建，并把 zip 暂存在
`os.tmpdir()`（`TMPDIR`）。测试容器 `/tmp` 是 **512 MB tmpfs**，**放不下**，因此
默认会卡在下载/解压。解决方法：

- 把 `TMPDIR` 指向可写、容量 ≥3GB 的路径（如 `/workspace/.tmp`），或
- 把 `/tmp` tmpfs 调大（≥3GB），或
- **推荐：在镜像构建时预装** Camoufox 到 `$XDG_CACHE_HOME/camoufox`
  （即 `~/.cache/camoufox`，可用 `npx camoufox fetch`），并把该目录设为只读随镜像分发，
  避免每次作业下载 1.4GB、也避免依赖共享工作卷。

安装目录默认 `~/.cache/camoufox`；Firefox 启动前还要求 `~/.camoufox` 目录存在。

### Camoufox 与自检评分的关系

Camoufox 由 fpgen **自己生成身份**（内核级），不套用本仓库的 `Fingerprint`。因此
`signalScore`（预期指纹一致性）对 camoufox **不适用**——它只用于 JS 注入型的
`chrome-lite`。对 camoufox 应看「能否启动 + 信号是否内部自洽」，而不是与我们的种子比对。
后续可为 native 引擎单独定义评分口径（只校验 webdriver 隐藏、代理 geo 一致等通用项）。

## 两个分数要分开理解

1. **signal-consistency（脚本自动打分）**：实际浏览器信号 vs 预期指纹的一致性，
   以及 `navigator.webdriver` 是否隐藏。**不联网可跑**，适合做 CI 门禁
   （`--min-score`）。
2. **sites 探测（启发式）**：访问 sannysoft / rebrowser / creepjs / pixelscan /
   browserleaks，按关键词判"疑似被拦"并截图。**最终以截图为准**，启发式只是提示。

## 演进路线（架构不变，只加实现）

| 层 | 现在 | 升级位 |
|---|---|---|
| 自动化泄漏 | patchright | 跟上游 release |
| 指纹生成 | 本仓库确定性生成 | 换 `fingerprint-generator` |
| 指纹注入 | `inject.ts`（JS） | 持续加固，或接 patched Chromium host |
| TLS/HTTP2 | 无 | host 增 `network` 能力：`curl_cffi` / `uTLS` |
| 存储 | JSON | SQLite / Postgres |
| 云 | 无 | 规则热更新 / profile 同步 / 团队 |

## 明确不做的事

- 不自研内核：内核是"可替换产物"，本仓库只做编排 + 注入 + 代理 + 自检
- 不承诺反检测效果：`chrome-lite` 是产品主线骨架，对抗能力需要持续迭代 `inject.ts`
  或升级到 patched Chromium host
