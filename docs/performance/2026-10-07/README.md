# CodeTape 性能实验：2026-10-07

结论：虚拟列表在长录制下明确限制了 DOM 数量，并改善大数据量 Seek 的呈现延迟；本轮不能支持“所有页面 LCP 都变快”的说法。实验还实际发现并修复了旧录制包读取失败。初测失败原样保留，修复后的独立旧包回放和真实 WebM 复测均成功。

## 原始数据与代码版本

| 文件 | 被测来源 | 实际范围与结果 |
| --- | --- | --- |
| [snapshot-seek.json](snapshot-seek.json) | `521550b` | 4 数据集 × 3 快照策略 × 100 目标 × 2 算法；2,400 个算法样本，所有目标的完整状态 SHA256 和最后应用序号等价 |
| [browser-initial-legacy-failure.json](browser-initial-legacy-failure.json) | after `521550b`，before `0ac9097` | 240 导航样本；53 条失败保留。另有 12 组 full/virtual 列表、1,200 次 measured Seek 全部成功 |
| [browser-legacy-fixed-replay.json](browser-legacy-fixed-replay.json) | runner `ede0d09`，Web 构建 `a79860f`；before `0ac9097` | 修复后独立旧包回放，80 导航样本，0 失败 |
| [media-seek.json](media-seek.json) | runner `ede0d09`，Web 构建 `a79860f` | 真 WebM，两个配置各 100 measured + 10 warmup Seek；200 次 measured 全部成功 |

`ede0d09` 仅修改测量脚本/测试，其 Web 源码与构建来源 `a79860f` 完全相同。各组不是同一次、同源码、同观察窗实验，不合并统计。[browser.json](browser.json) 是初测同字节副本，**不是修复后的全矩阵**。初测文件 SHA256：`87daf44c86f771b3cb8a790f61c846308497cefa7f454a0aa2a6a66f3075524c`。

环境：Apple M4、24 GiB 内存、macOS/Darwin 27.0.0、Node 24.19.0、Chrome 155.0.8059.40 headless、1440 × 900、DPR 1、AC 100%。单浏览器单页面顺序执行，无并行构建/测试/推理。desktop 不限速；limited 为 CPU 4× 降速、10 Mbps、100 ms 延迟，是模拟配置，不等于真实低端设备。

before 使用旧源码及**两组共用的升级后锁定依赖**，旧 Schema 显式保留 0.1.0；不是原始旧 lockfile 环境复现。实际共用 lockfile SHA256：`48ecd1b74dc51ac3b9347a8db8e3adb616aa2174c14a9af193c5ab6edf1393cf`。构建 index、数据 hash、资源字节、原始样本、p50/p75/p95 均在 JSON 中；分位数使用 R7 插值。

## 导航与兼容性：失败不删除

初测每路由、版本、配置分别 10 cold + 10 warm，三个路由为首页、录制、回放。cold 是新 BrowserContext 的 HTTP 冷缓存：仅在不加载应用的 blank 页面提前写 IndexedDB；warm 是同 context 第二次硬导航，不声称 OS/V8 缓存也完全冷启动。

初测观察口径是 **DOMContentLoaded 后固定等待 3 秒**，不是“从导航起只观察 3 秒”。LCP/ready 时间仍从导航 timeOrigin 起算，DCL 和主线程排队可能使总墙钟超过 3 秒。无点击、滚动或输入；ready 为页面标记/Monaco 可用后的下一次 RAF。

53 条初测失败中：

- 40 条为新版读取同一份 0.1.0 录制的真实加载失败：存储层把顶层版本强设为 0.2.0，但 manifest 仍是 0.1.0，原版本校验被拦截。原始 LCP 是错误提示，不能算成功首屏。已修复本地加载、ZIP 导出/导入使用原 manifest 版本，先校验原 checksum 再迁移，并补回归测试。
- 其余 13 条保留为观察窗未达到 readiness 的 censored/预算警告：before limited 回放 cold 10 条、after limited 录制 cold 3 条；未用错误页 LCP 充当业务就绪，也未删除后重算成“全部通过”。

修复后仅复测受影响的回放页面，独立改用 **DCL 后 10 秒**观察窗：两版本 × 两配置 × 10 cold + 10 warm，共 80 样本，0 失败；数据仍是相同的 0.1.0 包，hash `7381c46428f6df32113d9917962c32d1039fcba24b24a02a2563d96b1fc0dc38`。这验证了修复，不声称修复后所有样本满足原 3 秒预算。

| 修复后回放 | LCP p75 before → after，ms | ready p95 before → after，ms |
| --- | --- | --- |
| desktop cold | 1548 → 1101 | 1992.0 → 3073.3 |
| desktop warm | 116 → 147 | 101.0 → 121.7 |
| limited cold | 4347 → 4401 | 6556.3 → 4537.3 |
| limited warm | 439 → 468 | 414.3 → 465.5 |

不同分位数并非都改善，10 个样本也不足以宣称统计显著。初测 source 的首页 desktop cold LCP p75 是 1326 → 1547 ms、录制页是 1159 → 1253 ms；未实现普遍 LCP 改善。首页初始传输字节中位数下降约 26.8%（841,089 → 615,590），但传输减少不直接等于更快的 LCP。外部 Google Fonts 保留，网络波动也是限制；本实验 p75 不是线上真实用户 p75。

## 同一新版列表：full 与 virtual

仅在 `MODE=performance` 构建使用 `?benchmark=full` 比较**同一列表**；没有拿旧版只有 Slider 的页面比较“列表虚拟化收益”。以下全部对应初测 Web source `521550b`，与旧包失败/修复复测分开。每组 50 个种子滚动位置、10 次预热、100 次交替前后 Seek；等待目标事件高亮、期望代码首行和两个 RAF，不是仅计 reducer 返回。

| 配置 / 事件数 | 最大 DOM 行 full → virtual | Seek p50 full → virtual，ms | Seek p95 full → virtual，ms |
| --- | --- | --- | --- |
| desktop / 2k | 2000 → 25 | 41.4 → 37.5 | 43.6 → 52.6 |
| desktop / 10k | 10000 → 25 | 76.3 → 38.0 | 85.9 → 50.8 |
| desktop / 20k | 20000 → 25 | 121.5 → 37.7 | 140.8 → 51.1 |
| limited / 2k | 2000 → 25 | 72.9 → 43.8 | 87.6 → 46.4 |
| limited / 10k | 10000 → 25 | 211.4 → 42.8 | 257.8 → 46.3 |
| limited / 20k | 20000 → 25 | 482.9 → 43.1 | 570.9 → 47.3 |

虚拟列表所有滚动/Seek 样本满足 `rows ≤ ceil(H/48)+12`，本视口上限 25 行；12 组共 1,200 measured Seek 没有错误。2k desktop p95 没改善，不据此宣称任何长度都更快。

`filterSettledMs` 是页面已可用后点击“全部”过滤器到行数稳定的耗时，**不是首次挂载成本**。20k limited 单次观测为 full 11780.4 ms / virtual 48.6 ms；`firstTimelineRowsMs`、跟随 RAF 的初始导航时间另外保存，但每组只有一个，不拿它证明普遍首屏收益。该 20k limited 组记录到的长任务为 full 784 / virtual 0；具体任务/滚动 RAF trace 全量保留。RAF 间隔不是实测 FPS；浏览器只校验可见首行/高亮，不把期望状态 hash 当作实际整个 Monaco model hash。

## 快照策略与索引

固定种子 `20261007`：2k/10k/20k 事件、2 KiB 源码，以及独立 2k/20 KiB 源码；含同毫秒事件和语义节点，合法包均在 15 分钟 / 250 MiB 预算内。三策略是“时间 **或**稳定事件计数”加语义节点触发，非所有鼠标事件计数。每目标比较同 reducer、深克隆快照的完整状态与 seq；稳定事件索引在计时外构建。

20k / 2 KiB 数据的实际对照：

| 策略 | 快照数 | 快照 JSON bytes | upperBound p95，ms | linear-prefix p95，ms |
| --- | --- | --- | --- | --- |
| 2s / 20 stable events | 820 | 6115794 | 0.0115 | 0.0287 |
| 5s / 50 stable events | 420 | 3131369 | 0.0130 | 0.0283 |
| 10s / 100 stable events | 320 | 2385333 | 0.0176 | 0.0315 |

5s/50 比 2s/20 少约 48.8% 的快照 JSON，10s/100 更省存储但尾部重放更多。这是折中证据，不证明 5s/50 对所有录制最优；函数延迟的绝对差仅约百分之几毫秒，不能等同于用户感知延迟。2k/20 KiB 部分策略中 upperBound p95 没改善，也保留在原始数据中。生产快照有 flush/任务边界，本脚本是受控策略实验，不把模拟计数称为逐条实录一致计数。

## 真媒体独立组

[fixture](media-fixture/metadata.json) 使用隔离 Chrome fake-device 的真实 Native MediaRecorder，不接触个人摄像头/麦克风；28 events、8 snapshots、640 × 480、VP9/Opus WebM、468375 bytes。原包与 Blob integrity 都已验证，媒体原始 SHA256 为 `bc2df51f639b304c27243aab12892cf028d2351ecae74f7aff9d02a7eac88a2c`。

| 配置 | measured / warmup | 同步呈现 p50 / p75 / p95，ms | 失败 |
| --- | --- | --- | --- |
| desktop | 100 / 10 | 80.7 / 81.2 / 130.6 | 0 |
| limited | 100 / 10 | 63.4 / 77.8 / 130.2 | 0 |

每次是真实进度条指针点击，等 native video 非 seeking 且位于被接受的目标（允许 50 ms 误差）、期望代码首行，再等待两个 RAF；包含输入/呈现成本，不是纯解码时间。200 个 measured 样本都观察到 `seeking` 和 `seeked`，无 decoder error；native `currentTime` 属性与目标的最大差约 0.001 ms，**不代表画面帧或音频的物理同步精度**。limited 中位数更低不表示 CPU 降速让系统变快，这也提示小样本/调度噪声不可忽略。

录制时钟/package duration 是 6.064 s；native decoder 初始 duration 为 `Infinity`，完成后是 6.002 s，两者原样分开记录。目标范围限定录制时钟的 2%–98%，不声称覆盖最后一帧，也不把这份约 6 秒 / 0.5 MB 的结果推广到长高清视频。

## 独立真实模型 smoke：不与 LCP 混算

[browser-real-model-smoke.json](browser-real-model-smoke.json) 是测量结束后才执行的单次真实浏览器验证。隔离 Chrome 155、Node 24，通过 Vite 源模块调用未修改的默认 ASR 与生产 Worker LLM；只允许同源模型/WASM，没有真实设备、用户 profile 或付费 API。合成 WebM 与媒体组相同，每流程 60 秒硬预算；不是人声准确率或模型效果统计。

Whisper tiny / WASM fp32 首次预热 1185 ms、重复预热 0 ms（整数时间分辨率）、识别 1145 ms，返回一段合法时间戳。LLM / WASM q8 首次预热 2000 ms、重复预热 0 ms、推理至严格校验拒绝 9745 ms：输出未找到完整 JSON，**不是优化成功**。全部模型/WASM HTTP 200，重复预热及推理没有新的模型请求，未出现外域请求或 pageerror；所有临时资源已关闭。

这证明实例预热复用与模型执行，不证明 LLM 对所有输入能生成合法 JSON。调用者应保留 ASR 并提示优化失败，不能为了通过改弱验证。本地模型输出稳定性是已知改进点。测试使用 localhost、已准备权重及开发模块，不含公网下载耗时，也不与生产导航、媒体组或 jsdom 18.672 ms 替身混算；未测内存峰值。原始 Node SSR 加载失败另存 [subtitle-node-real-model-smoke.json](subtitle-node-real-model-smoke.json)，不把不同环境混为相同模型失败。

手工重现脚本见 [browser-model-smoke.mjs](../../../scripts/perf/browser-model-smoke.mjs)，需要 Node 24、`npm ci`、模型资产与 Chromium；没有纳入自动质量门禁。该严格拒绝样例会使脚本返回失败状态，禁止把非零退出修改成“全部通过”。

将临时验证整理为仓库手工脚本后，已实际 [重现一次](browser-model-smoke-reproduced.json)：ASR 再次完成，LLM 再次被完整 JSON 校验拒绝并返回非零状态，临时资源正常关闭。两份生成失败证据都保留，没有把重试中最好的结果择优发布。

## 可复现性与未覆盖范围

命令、fixture 生成与 CLI 约束见 [scripts/perf/README.md](../../../scripts/perf/README.md)。两端用独立冻结静态构建，实测期间未重新构建；原始 JSON `builds` 保存 index 指纹。模型请求两组同样通过 CDP 阻断，未使用会关闭 HTTP 缓存的 Playwright routing。

已核对冻结构建的 `collaboration`、`eventTimeline`、`subtitleAnchors` 三个发布开关均开启；性能构建允许 full 列表对照，普通生产 URL 不能据此关闭虚拟化。`eventTimeline=false` 的旧 Slider 路径、协同关闭路径、字幕锚点关闭路径未做性能对照；发布开关不降级服务器权限。静态服务仅模拟匿名认证，登录、云上传、WebRTC 时延不在这些测量里。浏览器性能组不运行真实 Whisper/LLM 推理，不据此声称 AI 加载速度或字幕准确率；独立字幕评估不得与本组 LCP/Seek 混算。
