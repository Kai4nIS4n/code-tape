# 第一阶段竞品分析汇总

> 关联 Issue：#3
> 汇总日期：2026-05-23

本目录汇总 code-tape 第一阶段竞品调研结果。调研覆盖互动式代码课程、代码录制回放、在线面试 IDE、在线沙箱和浏览器录制调试等方向，用于支撑 P0 技术路线拆解和后续技术文档编写。

## 子调研文档

| Issue | 调研对象 | 文档 | 主要参考价值 |
| --- | --- | --- | --- |
| #4 | Scrimba 互动式代码讲解模式 | [scrimba.md](./scrimba.md) | 证明“播放器即 IDE”的互动式回放体验值得作为 P0 产品参考。 |
| #5 | Codecast / CodeCast Create / RecDev | [codecast-recdev.md](./codecast-recdev.md) | 支撑“事件流优先，音视频/屏幕视频补充”的录制包和回放路线。 |
| #6 | CoderPad 协作 IDE 与面试回放 | [coderpad.md](./coderpad.md) | 参考按键级回放、多文件跟随、关键事件标注和代码执行风险。 |
| #7 | HackerRank CodePair | [hackerrank-codepair.md](./hackerrank-codepair.md) | 参考 key-by-key replay、音视频同步和实时面试能力边界。 |
| #8 | CodeSignal Interview | [codesignal-interview.md](./codesignal-interview.md) | 参考 coding replay、terminal session replay、回放检索和分享权限。 |
| #9 | CodeSandbox | [codesandbox.md](./codesandbox.md) | 支撑 P0 采用 iframe 前端展示路线，并参考分享、嵌入和项目保存体验。 |
| #10 | StackBlitz / WebContainers | [stackblitz-webcontainers.md](./stackblitz-webcontainers.md) | 对比 iframe、WebContainers、后端沙箱三条代码执行/展示路线。 |
| #11 | Replay.io | [replay-io.md](./replay-io.md) | 参考 time-travel debugging、事件索引和 seek 后状态恢复策略。 |

## 总体结论

第一阶段调研结论是：code-tape P0 应优先做“结构化事件流 + 音视频轨道 + 可恢复状态快照”的代码讲解录制回放工具，而不是普通屏幕录制工具，也不应在 P0 直接复刻完整云 IDE、实时面试平台或课程平台。

P0 需要证明的核心价值是：

1. 讲解者的代码内容变化、光标/选区、鼠标、快捷键和运行结果可以被结构化记录。
2. 麦克风和摄像头轨道可以与操作事件使用同一相对时间轴对齐。
3. 回放时可以暂停、倍速、seek，并恢复目标时间点的编辑器状态。
4. 代码运行/展示先采用低风险 iframe sandbox 路线，不把后端沙箱、WebContainers、终端录制作为首版必做。

## P0 模块启发

### 代码编辑器模块

- 编辑器应是录制和回放主舞台，优先选择 Monaco 或 CodeMirror 这类成熟编辑器。
- P0 先覆盖 JS/TS 或 HTML/CSS/JS 演示链路，数据结构预留 `language`、`files`、`activeFileId` 等字段。
- 多文件、主题、补全、格式化和快捷键可以借助编辑器能力实现，不需要自研编辑器内核。

### 操作录制模块

- 录制事实源应是结构化事件，而不是屏幕像素。
- P0 事件至少覆盖 `content-change`、`selection-change`、`cursor-change`、`scroll-change`、`mouse-move`、`mouse-click`、`shortcut`、`run-start`、`run-output`、`run-error`。
- 内容变化可以先保存变更后的完整代码，降低 seek 恢复难度；后续再演进为 diff 或 operation log。
- 终端事件在 CodeSignal、RecDev、WebContainers 中有参考价值，但会引入命令输入、流式输出、进程生命周期、文件系统同步和敏感信息过滤，建议 P0 只预留事件层，不作为必做。

### 音视频录制模块

- P0 只做本地麦克风和摄像头采集，不做实时多人音视频通话。
- 媒体轨道与操作事件都应记录相对 `recordingStart` 的时间戳，避免回放漂移。
- 屏幕录制可作为补充轨道，但不应替代代码事件流。

### 录制总控模块

- 录制总控需要统一管理编辑器事件、运行事件、媒体轨道、状态机和录制包打包。
- 推荐状态机：`idle` -> `recording` -> `paused` -> `stopping` -> `processing` -> `completed` / `failed`。
- 录制包应包含 `manifest`、事件流、媒体文件、运行结果快照和可选状态快照。
- 后续若支持云端回放中心，录制包格式要能独立校验、上传、下载和版本迁移。

### 回放模块

- 回放难点不是线性播放，而是 seek 后快速恢复代码、光标、选区、滚动、鼠标和运行结果状态。
- 推荐采用“全量快照 + 增量事件”的混合策略：从最近快照恢复，再静默重放到目标时间点。
- 回放默认还原录制时保存的运行结果，不应在 seek 或播放过程中自动重新执行用户代码。
- 章节、评论、时间点分享和搜索适合 P1 回放中心，不阻塞 P0。

### 代码执行/展示沙箱

- P0 推荐 iframe sandbox 前端展示：实现成本低、浏览器兼容性好、能支撑训练营 Demo。
- WebContainers 适合 P1 PoC，用于复杂前端工程、npm、终端和 dev server。
- 后端沙箱适合多语言执行、判题或强资源隔离需求，不建议进入 P0 主线。
- iframe 方案仍需限制弹窗、隔离宿主页面、捕获 console/error，并把运行结果写入事件流或快照。

## P0 / P1 边界

| 能力 | 建议阶段 | 原因 |
| --- | --- | --- |
| 单人代码讲解录制回放 | P0 | 是本项目主链路。 |
| 编辑器事件流和媒体轨道同步 | P0 | 决定录制包是否可回放。 |
| 播放、暂停、倍速、seek | P0 | 是回放体验底座。 |
| iframe 前端展示和基础 console/error | P0 | 成本较低，能展示代码运行结果。 |
| 终端事件、WebContainers、后端沙箱 | P1 / P1+ | 复杂度高，容易拖偏 P0 主线。 |
| 云端回放中心、搜索、分享、权限 | P1 | 依赖稳定录制包和后端存储。 |
| 实时多人面试、WebRTC、ATS 集成 | P1+ | 不是代码讲解工具 P0 必需能力。 |
| 课程平台、challenge、AI feedback | P1+ | 产品形态更重，适合主链路稳定后扩展。 |

## 建议进入技术文档的主题

后续技术文档应把本次调研转成可实现的工程设计，至少覆盖：

1. P0 总体架构和模块边界。
2. 录制事件 schema、事件 envelope 和事件类型清单。
3. 录制包目录结构、manifest、媒体轨道和快照策略。
4. 回放调度器、seek 状态恢复和倍速策略。
5. iframe sandbox 运行/展示路线、安全边界和 console/error 捕获。
6. P1 扩展点：云端回放中心、WebContainers、终端事件、分享权限和协作能力。
