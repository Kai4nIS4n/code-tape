# CodeTape 升级实施记录

依据：`docs/CodeTape-功能升级Spec.md`。开发分支：`feature/spec-upgrade`。目标：`Kai4nIS4n/code-tape`。

状态：功能开发与本地验收完成，验收资料提交到个人 fork；真实模型限制如下，不以模拟测试替代生成质量。

- [x] P0：维护者已批准，PRD、技术方案和 ADR-027 记录新范围。
- [x] P1：账号、JWT/refresh、SQLite 和私有磁盘持久化。
- [x] P2：实际资源权限、分享撤销、房间邀请和 WS ticket。
- [x] P3：五文档双向编辑、本地持久化/outbox 和离线重连。
- [x] P4：候选人唯一采集、Schema 0.2.0、旧包兼容及运行版本关联。
- [x] P5：虚拟事件列表、Seek 竞态与索引优化。
- [x] P6：字幕虚拟列表、历史上下文、可靠定位和条件预热。
- [x] P7：路由加载、真实浏览器链路、性能测量和恢复演练。
- [x] 个人 fork [PR #2](https://github.com/Kai4nIS4n/code-tape/pull/2)，业务完整 CI 和实际评论审查；没有出现自动审查评论，不伪称机器人 CR 通过。

## 本地环境与保留内容

原有 `apps/web/tsconfig.app.json` 改动以及面试资料、代码学习路线、技术债等未提交文件保留，不纳入本次业务变更。升级 Spec 为本次实施依据，会纳入升级提交。

当前本机旧 Node 23 环境与原 checkout 的生成目录曾出现 Vite/TypeScript 阻塞。实际验证使用 Node 24、独立临时 checkout 和干净依赖；原 checkout 的源码最终以快进方式同步，用户既有改动保持不变。

## 已交付能力

- 账号：Argon2id 密码、15 分钟 JWT、HttpOnly refresh Cookie 轮换、退出撤销；前端登录态隔离与刷新竞态保护。
- 权限：房间成员/邀请与一次性 WS ticket；云录制创建、上传、校验、分享撤销，以及实际 GET/HEAD/Range 下载全部受保护。旧匿名旁路默认关闭。
- 协同：五个稳定文档绑定 Monaco/Yjs，服务端 SQLite 持久化后 ACK，浏览器 IndexedDB 更新日志/outbox，刷新与断线重连合并；光标 Awareness 不写入持久正文。
- 录制：只由候选人采集双方已经合并的正文，保留 300ms 防抖/1000ms 最大等待及 5s 或 50 稳定事件快照规则；暂停、恢复、停止前刷新正文。
- 回放：0.1.0 原字节校验后迁移，0.2.0 文档与运行版本关联；事件/字幕定高虚拟列表、二分索引、最后一次 Seek 生效，切包重置时钟并释放媒体。
- 字幕：按处理窗口解析历史代码与输出；严格校验分块结果，事务/CAS 保存派生资产，过期任务不覆盖新结果；可信选区 anchor 和条件串行预热。
- 工程：懒加载路由、三个前端发布开关、真实服务 Playwright 链路、可重复性能脚本、停机备份/验证/新目录恢复工具。

## 真实验证与边界

最终业务修复 `a79860f` 与测量脚本提交 `ede0d09` 的普通 pre-commit、pre-push 门禁均已实际通过：脚本 152、Schema 14、API 225、Web 913、Playwright 9 条（合计 1,313），以及 Web lint 与生产构建。个人 fork 的 Workflow Tests / quality、Contract Guard 均通过。另一次显式 Web lint 零警告通过。所有计数是该次实际执行结果，不代表覆盖率或真实模型准确率。

收尾实际发现并修复：跨录制包时钟基线泄漏、旧 restore 抢先改登录状态、socket.send 失败误报本机存储失败、快照 flush 重入/订阅者次序，以及候选人创建后 URL 未保存 roomId 导致刷新新建房间。候选人规范地址更新不会重建当前会话，真实刷新/离线/重启场景已通过。

Playwright 使用真实 API、SQLite、WebSocket 和两个独立账号，覆盖离线编辑、页面刷新、API 重启、未激活 HTML 文档录制/回放，以及撤销分享后旧资产 grant 失效。媒体性能样本由独立 Chrome 的 fake 音视频设备经过真实 MediaRecorder 生成，不含用户麦克风或摄像头数据。

字幕契约评估和 worker 响应性测试使用可控模型替身，不等于真实识别准确率或真实推理速度。Node SSR 的真实模型 smoke 因 `fetch failed` 未完成加载，不记为推理通过；随后实际验证了隔离 Chrome 中的同源自托管模型，不使用设备或付费 API。ASR 真实识别成功并返回一段合法时间戳；默认本地 LLM 权重/Worker 加载成功，但该单条样例的生成输出缺少完整 JSON，被严格校验拒绝，不能算纠错/章节生成成功。没有放松校验或伪造结果，本地小模型的 JSON 输出稳定性仍需改善。

原始字幕评估保存在 `docs/performance/2026-10-07/`：7 个契约样本通过，`representativeOutputSource=postprocessor-runner`、`overallEvaluationDurationMs=1.7713`；jsdom 替身的点击到可用结果为 `18.672ms`、超时预算 `60000ms`、回放探针响应为 true。仅录摄像头或旧云描述符未明确音轨时不自动预热 ASR；新 API 直接提供真实轨道标记，不由设备可用性推断。

真实模型单次 smoke：Whisper 首次预热 `1185ms`、识别 `1145ms`；LLM 首次预热 `2000ms`、推理至校验拒绝 `9745ms`。重复预热均复用实例，不重新请求模型。测量是本机同源开发模块与已准备权重，不是公网下载、生产首屏或准确率评估；合成音频也不是人声识别质量样本。原始结果见 `browser-real-model-smoke.json`，可用手工脚本 `scripts/perf/browser-model-smoke.mjs` 重现，不纳入自动质量门禁。

## 性能与兼容性验收

详细口径、源版本与原始数据见 [性能报告](performance/2026-10-07/README.md)。首轮保留 240 个导航样本及 53 条失败，其中 40 条真实旧包加载失败暴露了存储包装版本错误。修复本地加载、旧 ZIP 导入/导出并新增四条修前失败/修后通过的回归后，同一旧包 80 个独立导航样本全部成功。

三数据规模的同版列表对照完成 1,200 次 Seek：2 万事件虚拟 DOM 最大 25 行，受限环境该组 Seek p95 从 `570.9ms` 到 `47.3ms`；小数据并非所有分位数都改善。独立原生 WebM 200 次跳转全部成功。快照/索引的 2,400 个算法样本完整状态与序号等价。没有声称所有页面 LCP 改善，也没有把不同代码版本和观察窗混成一个实验。

本版服务端是单实例 SQLite/私有磁盘，未部署到外部生产环境；不声称具备多实例广播或生产备份 SLA。代码运行仍限 JS/TS 与 HTML/CSS，Python 仅编辑/回放；不包含 Worker 多语言执行升级。

## 2026-10-09：精简协作观察通道

按维护者后续要求，将协作模式的 DataChannel 与录制 Schema 分离。`observer-event` 保留原 seq：正文修改仅传 documentId/version，其余无需展示的操作为 noop；生命周期及语言/主题/字号为元数据。`observer-snapshot` 仅含 view、recordingStatus、runtime。record-start 的 initialDocuments、resume-baseline 的正文快照及周期快照都不再携带编辑器输入。运行 stdout/stderr/previewHtml 仍是允许的运行产物，不能按字符串出现“代码”就删除。

面试官使用独立观察 reducer、严格字段白名单和通用排序缓存；没有 editor.code/documents，没有 replayReducer，没有当前 Y.Doc hash 与历史事件的比较。runId/inputDocumentsHash 关联执行时输入，不匹配的过时结果忽略，但观察序号仍前进。发布和接收模式由协作开关固定，Yjs 暂时不可用时显示协作状态/草稿出口，不退回历史正文编辑器。旧只读模式保留原全文事件、快照和 Hash 恢复机制。

候选人 EventBus、录制包、完整代码及离线回放不变。观察快照先累计本地已发生的元数据，再独立尝试发送：run-start 临时发送失败不能使随后输出丢失输入 Hash，快照 seq 必须标记实际覆盖的本地事件，而非误称已交付的位置；发送成功集合仍只记录成功发送。5s/50 阈值按原录制稳定事件计算，快照前 flush 与订阅者次序保护保留。

新增定向验证包括所有五文档、初始/恢复/周期快照无输入全文、原始录制事件未改、占位保持连续 seq、乱序/重复/快照后重放、失败发送恢复及运行身份、旧模式兼容、严格拒绝字段注入。真实浏览器用隔离合成设备建立原生 SDP/ICE/DataChannel：面试官 Yjs 断线后修改 HTML，实际收到候选人轻量快照仍不覆盖草稿；重连合并、双方运行预览、成品完整 HTML 和离线回放继续有效。

该浏览器用例同时暴露既有的候选人最后重载媒体协商边界：当前代码只在面试官 joined 后启动 offer。测试通过面试官真实晚加入建立连接；本次未顺手修改这一旁路行为，不将其表述成已经修复。

本次修改完整 `quality:local` 实际通过：脚本 153、Schema 14、API 225、Web 933、Playwright 9（合计 1,334），Web 零警告 lint、类型检查及生产构建通过；原录制/采集/共享 Schema 文件没有改动。新增文档契约检查确保权威方案与元数据协议保持一致。
