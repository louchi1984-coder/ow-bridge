# OW Bridge

跨平台托盘应用，通过隔离的 OpenCode 为 WorkBuddy 提供免费模型。使用 Electron 共用界面和现有 Node.js 代理核心。

> **Windows x64 免安装版已在 Windows 实机验证，推荐下载 v0.2.9 portable 包。macOS（Apple Silicon）版也有实际使用验证。Windows ARM64、Linux 仍未正式测试，不能沿用 x64 的验证结论。**

## 界面预览

![OW Bridge macOS 控制面板：免费模型、能力标签、响应耗时与导入按钮](docs/images/control-panel-macos.png)

截图来自 macOS 实际运行界面；模型名单、免费额度和检测结果会随上游变化。

## 下载

[下载最新版本](https://github.com/louchi1984-coder/ow-bridge/releases/latest)

| 系统 | 验证状态 | 下载 |
|---|---|---|
| **Windows x64** | **已验证 · 推荐免安装版** | [v0.2.9 Portable ZIP](https://github.com/louchi1984-coder/ow-bridge/releases/download/v0.2.9/OW-Bridge-0.2.9-win-x64-portable.zip) |
| macOS 13+，Apple Silicon（M 系列） | 已实际使用验证，ZIP 签名完整性检查通过 | [v0.2.9 Mac ARM64 ZIP](https://github.com/louchi1984-coder/ow-bridge/releases/download/v0.2.9/OW-Bridge-0.2.9-mac-arm64.zip) |
| Windows ARM64 | 未正式测试，旧版 | [v0.2.2 ARM64 安装程序](https://github.com/louchi1984-coder/ow-bridge/releases/download/v0.2.2/OW-Bridge-0.2.2-win-arm64.exe) |
| Linux x64 | 实验性，未正式测试，旧版 | [v0.2.2 AppImage](https://github.com/louchi1984-coder/ow-bridge/releases/download/v0.2.2/OW-Bridge-0.2.2-linux-x86_64.AppImage) |

请先安装 WorkBuddy。无需另装 Node.js 或 npm，应用按需下载 OpenCode（官方 npm 优先，失败尝试 npmmirror）。Mac 使用临时签名，未做 Apple 公证；Windows 未做发布者签名，系统可能提示未知开发者。Windows x64 提供免安装 ZIP；NSIS 安装器未更新。免费模型及额度由上游决定。

## 使用

- macOS：解压 `OW-Bridge-0.2.9-mac-arm64.zip`，双击 OW Bridge.app。
- **Windows x64：完整解压 `OW-Bridge-0.2.9-win-x64-portable.zip`，双击文件夹里的 `OW Bridge.exe`。无需安装；不要只复制 exe，必须保留旁边的 `resources`、DLL 等文件。**
- 首次启动自动准备 OpenCode、扫描免费模型、检测可用性；找到有效 WorkBuddy 配置后自动导入。
- macOS 保持使用 `~/.workbuddy/models.json`。Windows 自动识别默认配置、已保存位置和 WorkBuddy 配置目录环境变量。常规路径找不到时，模型检测后自动用独立 OpenCode 只读会话搜索 `models.json`；有效候选自动记住并导入；找到多个时，选择查找校验前最后访问时间最新的一份，不再弹窗选择。也可从 Windows 托盘“自动查找 WorkBuddy 配置…”重新查找，或“选择 WorkBuddy 配置…”手动指定；首次使用请先在 WorkBuddy 保存一个自定义模型。Windows 托盘菜单“选择 WorkBuddy 配置…”可更换位置，切换时清理旧文件中的本应用条目。不会在猜测的位置新建模型配置。
- 后续重新扫描或检测不会改 WorkBuddy；点击“导入 WorkBuddy”更新，界面会反馈结果。
- 关闭窗口继续在托盘运行；从托盘退出时删除本应用导入的模型，保留用户手动配置。
- 图片输入、推理声明和档位、输入输出上限读取 OpenCode 目录；工具转换能力通过模拟工具请求检测。
- 系统代理开关支持 Mac 和 Windows 的手动 HTTP/HTTPS 代理。

使用问题在抖音/视频号 @娄老师说的对

## Mac 首次打开提示

v0.2.4 已修复旧包签名不完整的问题，使用 **ad-hoc 临时签名**，未做 Apple Developer ID 签名或公证，仍可能被 macOS 拦截。请下载新版 ZIP，解压后将 `OW Bridge.app` 拖入“应用程序”。

先尝试打开，再到“系统设置 → 隐私与安全性”点击“仍要打开”。如果仍提示“已损坏”，请确认文件来自本仓库 Release，且 ZIP 的 SHA-256 与该版本 `SHA256SUMS` 一致；确认信任此应用后，可在终端仅移除此应用的下载隔离标记：

```sh
xattr -dr com.apple.quarantine "/Applications/OW Bridge.app"
```

之后重新打开。此操作不会关闭系统整体的 Gatekeeper；它跳过此应用的下载隔离检查，不是 Apple 公证。请勿对来源不明或哈希不符的应用执行。目前 Mac 包仅支持 Apple Silicon（M 系列），要求 macOS 13 或更新版本。

## 开发与打包

```sh
npm ci
npm test
npm run desktop
npm run build:mac
npm run build:win
```

运行核心服务：`npm start`。开发依赖 Node.js 22+；打包后的应用不要求用户另装 Node。

Windows ARM64：`npm run build:win:arm64`。Linux 的 `npm run build:linux` 为实验性入口，系统代理和 WorkBuddy 集成尚未验证。平台路径、架构、退出清理与实机验收见 [跨平台说明](docs/cross-platform.md)。

## 代理行为和限制

Windows 首次启动默认读取系统 HTTP/HTTPS 代理，没有可用配置时自动直连；已保存的代理开关优先。版本查询和运行时下载都使用该设置，官方 npm 失败后尝试 npmmirror 国内镜像，仍校验 SHA-512 与下载后的版本。镜像是第三方来源；若官方元数据获取失败，校验值也来自镜像。代理连接异常时，运行时下载会回退直连；首次启动自动选择的代理失效时，隔离模型服务也改为直连，已明确保存的模型代理开关保持不变。仅 PAC/SOCKS 暂不支持。

启动时查询 npm 的 `latest`：本地版本不旧则复用，旧版本下载更新；版本查询失败时回退使用已有运行时。已查到新版本但下载失败时，目前仍会报错，未自动回退。状态记录实际运行版本。使用隔离配置，不批准原生执行工具。WorkBuddy 负责执行外部工具；代理校验模型返回的调用名称、参数和格式。工具检测仅反映单次请求的结果，复杂流程可能仍失败。

所有可用模型在本地 API 中公开。只通过普通对话检测的模型关闭工具调用；不可用模型仍显示在列表，但不会提供给 WorkBuddy。检测提供多个外部工具且不强制调用：只回复文本、不产生动作的模型按**仅对话**发布（工具关闭，界面显示"可用 · 仅对话"），不会通过检测后浪费真实轮次；真实超时单独记为"检测超时"。语义没命中（只回文本、或动作与请求不符）会重试一次再判定，共用同一个 60 秒预算；格式不兼容与超时不重试。

模型名称是 `OC · ` 加 OpenCode 原名。导入和退出只修改 `buddyBridgeOwner` 属于本应用的条目，并在实际写入前备份；手动配置保留。配置路径默认 `~/.workbuddy/models.json`，Windows 的 `~` 对应用户目录。

图片接受 PNG/JPEG/WebP/GIF 的 base64 data URL，不接受远程图片链接或本地文件路径，整个请求上限 8 MB。图片作为附件转发，不调用 OpenCode 原生读取工具。

推理声明与可调档位分开处理。支持推理但无档位的模型也勾选推理，保持 OpenCode 默认模式，不提供开关或档位；有档位的填写 `supportedEfforts`，默认优先 medium。`reasoning_effort` 或 `reasoning.effort` 映射为 OpenCode variant，声明了可调档位的模型遇到不支持的档位时返回 400；支持推理但没有 variants 的模型兼容 WorkBuddy 默认附带的推理档位，使用 OpenCode 默认模式，不转发不存在的档位。不转发思考过程文本。

输入上限优先读取 `limit.input`，缺少时 WorkBuddy 配置回退 `limit.context`；详情仍分别展示上下文与独立输入上限。输出上限读取 `limit.output`。

代理兼容工具调用中的空/省略 content、纯文本回答省略 calls、OpenAI 风格 tool_calls 和 JSON 字符串参数；未知工具仍拒绝，已知工具缺少必填参数交给 WorkBuddy 校验。工具执行错误原样保留在外部会话中，由 WorkBuddy 决策；一次请求的格式/工具转换失败不会取消已检测通过的模型资格，额度、访问等可用性错误和重新检测结果仍生效。

格式不合格、坏调用项或输出截断会进入纠正与辅助转换流程。主模型每个请求最多三轮，检测不使用辅助转换；WorkBuddy 取消或断开请求时，代理停止 OpenCode 会话。主请求不会因等待时间或暂时没有内容事件而被代理自动中止。

支持 Chat Completions 和 SSE；收到上游真实内容后，立即发送仅含 assistant 角色的起始块，供客户端切换响应状态。正文与工具参数仍在完整回复处理后输出，不是逐 token 实时流；不注入进度文字或思考过程，WorkBuddy 的实际状态文案仍需客户端联调确认。
请求结果记录 `calls`、`nativeAttempts`、`steps`、`handoff`、`repaired` 作为"最近一次调用"的观测，但不参与能力判定（能力标签只由检测决定）。格式兜底只在失败时触发一次：把原模型响应、完整外部文本对话、真实工具描述与参数定义交给另一路模型转换。指导要求保留原动作、文件正文和命令，按客户端定义转换字段名；材料不足时返回 `{"unrepairable":true,"reason":"具体缺失项"}`。信封转换失败后，把具体诊断交回原模型作最后一次纠正；动作转换失败也在现有轮次内请求原模型补齐后重发。已有正常工具调用的参数错误仍交给 WorkBuddy 的工具反馈循环。检测过程从不兜底。转换材料不再截断字符串或嵌套对象，因此长对话会使用更多上下文，仍受辅助模型的上下文上限约束。被拦截的原生审批请求原文保存在 `status.json` 的 `lastPermission`，用于诊断模型为什么没有把动作交给 WorkBuddy。

请求进行中会订阅 OpenCode 的 `GET /event` 事件流，把当前模型、已等待时长和上游重试次数实时写入 `status.json` 的 `activity`；控制面板服务行与托盘据此显示"等待上游 · 第 N 次重试"，不再出现整轮无输出。请求结束或取消时条目立即移除。事件流按需启动，断开后按 1 秒退避重连，运行时停止时一并关闭。

被拦下的原生动作会**先尝试转交**：按 `callID` 反查该次工具调用，把 bash/read/write/edit/glob/grep/skill 类动作按本次 WorkBuddy 提供的工具 schema 映射成外部调用（`bash`→`Bash`；`read` 的 `filePath`→`file_path`；write/edit 连带 `content`、`old_string`、`new_string`；`glob`→`Glob` 或 `LS`；`grep`→`Grep`；`skill`→`Skill`；参数名候选由目标 schema 决定，未声明的键一律丢弃），映射成功就中止这一轮生成并直接作为 `calls` 返回，不再要求模型重述。映射失败才回退到拒绝并指出工具名；反复尝试不再中止整个请求。暂不支持 Responses API、Anthropic Messages API；`temperature`、`max_tokens` 等参数不透传。模型免费额度和可用性由上游控制。

## 验证

`npm test` 覆盖协议校验、导入与退出清理、目录能力映射、图片转发、推理档位和系统代理解析。**Windows x64 portable 已由用户在 Windows 实机验证**，Windows Codex 记录包含核心服务、Electron 启动、模型扫描、隔离配置导入和 5 个模型真实 API 请求成功；v0.2.9 自动测试 105 项通过、0 跳过。这里不承诺所有模型或复杂工作流均稳定。macOS 有既有实际使用验证；Windows ARM64、Linux 仍未正式测试。产物未做商用发布签名/公证。

自动查找额外通过本地目录枚举补齐 OpenCode glob 可能漏掉的 `.workbuddy` 隐藏目录，并与模型找到的候选合并。自动查找只允许目录和文件名搜索，配置内容由本地程序验证，不交给模型。依赖可用的免费模型；查找失败仍可手动选择。已有有效旧文件时不会判断其是否已被 WorkBuddy 弃用，请通过托盘重新查找。详见 [配置查找说明](docs/config-finder.md)。

### v0.2.9：启动恢复与选择性导入

服务在启动最初就绑定本地端口，由操作系统保证独占，`service.pid` 仅记录当前进程。异常退出后遗留的 PID 或被其他程序复用的 PID 不再阻止启动；真实端口冲突仍会报错，不会结束占用端口的其他程序。

控制面板模型行增加导入勾选框。默认勾选可用模型；选择会保存，之后启动自动导入及托盘导入沿用选择。更改勾选不立即修改 WorkBuddy，点击“导入 WorkBuddy”后应用；全不选再导入仅清除本应用模型，保留手动配置。检测失败的模型不会导入。

本机与 Windows 各 105 项自动测试通过，Windows 免安装包另通过启动/强杀恢复/端口冲突/选择导入的流程测试。界面点击与导入反馈通过浏览器隔离接口测试；模型推理沿用此前实现，本轮未重新测试所有真实模型。
