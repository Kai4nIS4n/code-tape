# CodeTape 功能升级 Spec

状态：实施中。版本：v1。日期：2026-10-07。维护者已在本次开发指令中批准按此 Spec 实施。

本文是本次功能升级的实施依据。实现进度和实际验证结果记录在 `docs/CodeTape-升级实施记录.md`；“实施中”不代表所有能力已经通过验收。

测试与性能测量纳入规划，但不以“1,068 个测试”或“LCP 从 3.2s 降到 2.1s”为验收要求。先建立真实基线，再根据数据确定预算；未测量的指标不得写成成果。

## 1. 目标、范围与默认决策

### 1.1 最终要达到什么状态

1. 两名已登录用户能够同时编辑同一份代码，短暂断网期间仍可编辑，重连后自动合并文本。
2. 候选人仍可录制代码、操作、运行结果和音视频；协同产生的代码变化可以被录进统一时间轴，并通过快照和事件确定性回放。
3. 回放页有真正的事件时间轴列表，支持筛选、定位和可视区域渲染，能够处理 2,000 条以上事件。
4. 云端录制属于真实账号；录制元数据、分享链接以及实际媒体文件受到同一套权限控制。
5. ASR、LLM 纠错、字幕分块、章节生成继续可用；点击字幕不仅跳时间，还能在有可靠依据时定位到当时的代码光标或选区。
6. 页面、编辑器和 AI 资源按需加载，有可复现的性能报告和关键链路测试。

### 1.2 本版选定的方案

| 事项 | 决策 | 原因 |
| --- | --- | --- |
| 双向正文合并 | Yjs CRDT；Monaco 绑定 Y.Text | 支持并发与离线更新合并，不自行实现 OT 算法 |
| 正文传输 | 独立 collaboration WebSocket | 可在无摄像头、无 WebRTC 的情况下编辑；服务端可鉴权、持久化 |
| 现有 DataChannel | 保留为候选人录制观察流、运行结果及状态快照通道 | 复用现有序号、哈希、快照恢复能力，但不再承担双向正文合并 |
| 录制事实源 | 候选人唯一 RecordingClock、EventBus、MediaRecorder | 避免把两台机器的时钟和序号强行合并 |
| 登录 | 用户名与密码；标准 access JWT + refresh Cookie | 先完成最小完整账号体系，不引入邮箱或第三方 OAuth |
| 服务端持久化 | 单实例 Node + SQLite + 私有磁盘媒体 | 满足当前规模的持久化需求，暂不引入分布式协同集群 |
| 执行语言 | JS/TS 执行，HTML/CSS 页面预览；Python 仅编辑与回放 | 与现有运行时能力一致；iframe 本身不是 Python 解释器 |
| 虚拟列表 | 固定高度事件行和字幕预览行，共用小型定高虚拟化 hook | 需求可控，无需为第一版引入复杂动态布局机制 |
| 字幕定位 | 时间对应历史状态 + 录制光标/选区；允许手动关联 | 可确定性校验，不把时间映射夸大为语义理解 |

首版明确不做：三人以上协作、任意多文件工程、文件树、Git 式分支合并、跨设备统一撤销、多方独立录制合流、服务端执行用户代码、Python 运行时、运行时迁移 Web Worker、团队级 RBAC、公开录制搜索。

### 1.3 与现有权威文档的关系

`docs/PRD.md` 仍是产品权威；`docs/技术方案.md` 第十二章当前明确采用候选人单写、面试官只读，并不引入 CRDT/OT。本 Spec 是对该边界的变更提案，不能直接作为绕过原技术方案的依据。

维护者已明确要求按本 Spec 完成开发；本次同步 PRD、技术方案及 ADR-027：允许双方编辑，保留单录制者时间轴，增加账号权限与持久化，采用新录制 Schema。原方案的 P0/0.1.0 描述保留用于历史兼容；本次升级范围以内以新增批准章节为准。

## 2. 当前实现与升级差距

| 简历描述 | 当前源码情况 | 本次工作 |
| --- | --- | --- |
| 快照 + 增量事件恢复 | 已有 SnapshotBuilder、replayReducer、replayScheduler | 保留；补齐协同文档语义与并发 Seek 保护 |
| 时间轴可视区渲染 | ReplayControls 主要为进度 Slider，尚无事件虚拟列表；字幕全量 map | 新增事件列表，虚拟化字幕预览列表 |
| 双人实时协作 | 面试官 CodeEditor 设置 readOnly；当前为候选人状态同步 | 新增 Yjs 双向编辑，旧观察流与可编辑正文隔离 |
| JWT 登录鉴权 | 当前为设备 token 换自定义两段签名 token，不是账号登录体系 | 新增账号、标准 JWT、会话、资源与 WS 授权 |
| 云端录制与分享 | 已有上传/校验/分享服务；demo 元数据、房间和对象仍主要存内存 | 持久化；保护实际资源下载；完善撤销和迁移 |
| 浏览器 AI 字幕 | 已有 Whisper、浏览器本地后处理模型、外部模型适配及返回校验 | 保留并优化预热、历史上下文与确定性代码定位 |
| 字幕点击代码定位 | 当前主要是 seek 到字幕开始时间 | 新增可校验的 code anchor 和编辑器定位装饰 |
| 拆包与懒加载 | 部分重依赖已动态加载，页面路由仍静态导入 | 路由分包、统一加载状态、条件预热及测量 |
| 测试与性能成果 | 已有 Schema/API/Web/E2E 基础 | 按风险补场景；实际运行后统计，不预设通过数或优化结果 |

## 3. 两套状态模型必须分清

### 3.1 协同正文与录制状态不是同一种数据

协同正文以 Y.Doc 为事实源，负责“双方最终编辑成什么内容”。录制状态以候选人 EventBus 为事实源，负责“候选人在录制时间 T 看见什么内容、运行了什么、媒体处于什么状态”。

必须遵守以下约束：

- Yjs 内部时钟、服务端 persistedRevision、录制 event.seq 是三个不同概念，不能互相替代。
- 两名用户的 Date.now() 不用于拼接全局录制顺序。
- 协同正文变化可以触发录制事件；回放事件或观察流快照不得反向修改实时 Y.Doc。
- CRDT 文本最终一致不代表程序语义正确。双方同时重命名同一变量后，仍可能需要人工修正代码。
- 进入房间即可协同，是否开启录制不影响正文同步。

### 3.2 通信通道职责

| 通道 | 承载内容 | 不承担的职责 |
| --- | --- | --- |
| HTTP API | 登录、邀请、房间权限、WS ticket、录制上传和分享 | 不轮询整份代码实现协作 |
| signaling WebSocket | SDP、ICE、成员控制、连接状态 | 不承载录制包正文 |
| collaboration WebSocket | Yjs 同步、更新、Awareness、持久化 ACK | 不承担音视频传输 |
| WebRTC 媒体轨道 | 实时音视频 | 不作为代码回放事实源 |
| WebRTC DataChannel | 候选人录制事件、序号、哈希、状态快照、共享运行结果 | 不回写协同正文、不合并离线编辑 |

首版不同时通过 WebSocket 和 DataChannel 发送同一份 CRDT 更新。这样无需再维护双路径优先级、防环和两套文档授权规则。

如果 WebRTC 建连失败，页面仍可通过 collaboration WebSocket 编辑代码；显示音视频/候选人观察流不可用，不把整个工作区禁用。申请摄像头或麦克风失败不能阻止正文连接；信令与媒体初始化也不应因为必须先拿到本地媒体才无法应答。

## 4. 双人协同的具体实现

### 4.1 房间、文档与身份

每个房间最多绑定两名账号：candidate 为创建者及 recording owner，interviewer 为受邀参与者。双方都有正文编辑权；只有 candidate 可以开始、暂停、停止正式录制和管理该录制的云端归属。

房间使用服务器生成的 roomId 和 documentEpoch。epoch 表示文档的一代，只有显式重建文档时才改变，普通断线不改变。workspaceId 由 roomId 与 epoch 组合。

Y.Doc 内固定五个 Y.Text：`source:javascript`、`source:typescript`、`source:python`、`source:html`、`source:css`。本版不新增任意文件树。服务端创建房间时只初始化一次默认文本，客户端不能因为刚加入时暂时看见空文档就自行写入模板。

账号 userId、连接 connectionId、Yjs clientID 分开处理。userId 由服务端认证确定，clientID 仅是 CRDT 实例身份，不能作为账号凭据，也不能人为固定成用户 ID。

### 4.2 Monaco 接入

新增 collaborationSession 管理 Y.Doc、连接、持久化和 Monaco model 生命周期；每种语言一个稳定 model，并通过 y-monaco 绑定到相应 Y.Text。

- 非协同录制/回放保留现有受控编辑器模式。
- 协同模式由外部 model + Yjs 驱动，禁用原 React value effect 对正文的 setValue，避免反复覆盖和光标跳动。
- 当前语言标签、主题、字号、滚动位置是每个人的本地视图状态。A 切换到 HTML 不强迫 B 切换。
- Awareness 显示在线状态、正在查看的文档、光标及选区。使用与共享文本对应的相对位置，断线后过期清除，不把光标心跳存为持久正文更新。
- 撤销/重做使用 Y.UndoManager，trackedOrigins 只包含本地编辑绑定；接管相应命令，避免再执行 Monaco 原生撤销栈而撤回对方修改。
- 清理绑定、监听、UndoManager、WebSocket 与未使用 model；路由切换后不能保留重复订阅。

### 4.3 首次加入链路

1. A 登录并创建房间，服务器保存房间、成员、初始化 Y.Doc 和 epoch。
2. A 生成有有效期的邀请；B 登录后兑换邀请，服务端将第二个成员名额绑定到 B 的 userId。
3. 两端通过已认证 API 取得房间信息及一次性 collaboration ticket，建立 WebSocket。
4. 客户端加载本地缓存的同一 workspaceId，使用 Yjs 同步协议交换服务器与客户端缺失的状态。
5. 初次同步完成后连接 Monaco；若是已有离线草稿，则保留本地可编辑状态并显示同步进度，不用服务端纯文本覆盖本地。
6. 更新 Awareness，另行建立已授权的 WebRTC 媒体与 DataChannel。

### 4.4 更新、持久化与 ACK

采用 Yjs/y-protocols 的同步与 Awareness 编码，外加应用层帧。使用独立 provider 包装协议，不假定现成 y-websocket 的 synced 事件已经代表服务端落盘。

应用层最小消息形状如下；正文更新使用二进制帧，以下仅为逻辑结构：

```ts
type DurableUpdate = {
  type: "update";
  workspaceId: string;
  epoch: number;
  updateId: string;     // 随机 UUID；重试复用同一个 ID
  update: Uint8Array;
};

type UpdateAck = {
  type: "ack";
  updateId: string;
  persistedRevision: number;
};
```

更新流程：

1. 本地输入立即修改 Y.Text；同一个 IndexedDB 事务保存 CRDT update 和待确认 outbox，再发送网络消息。本地分区 key 包含 `(userId, roomId, epoch)`，防止切换账号后自动提交其他账号的草稿。
2. 首版为这一事务实现小型本地持久化适配器，不另外使用一个独立数据库的自动持久化 provider，避免“正文已存、outbox 未存”的双写窗口。
3. 服务端按房间串行处理：验证连接身份、成员编辑权限、epoch、updateId、大小和合法编码；在隔离的待提交状态上应用并校验文档总大小。只允许预定义的五个 Y.Text 根键与类型，同时限制完整 CRDT 编码大小，不能只检查可见源码长度而允许额外共享根键或无限膨胀的历史结构。
4. SQLite 事务写 update、revision 和幂等记录；事务成功后提交内存状态、广播并返回 ACK。失败不广播、不 ACK，丢弃待提交状态。
5. 唯一键为 `(roomId, epoch, updateId)`，同时保存 updateHash。同 ID 相同内容重试返回原 ACK；同 ID 不同内容拒绝。
6. 客户端收到对应 ACK 才清理 outbox 并标记“服务端已保存”。只有 socket open 或 sync 完成不能显示这一状态。
7. 服务端已提交但广播/ACK 前崩溃时，重启从持久状态恢复；客户端重试不会重复产生正文效果。

收到服务端的 CRDT 更新也必须进入本地持久日志，供离线刷新恢复完整文档，但不得再次加入发送 outbox。通过 transaction origin 区分本地、远端与恢复过程，避免重复发送；缓存只存本地产生的更新会缺少远端依赖，不能视为完整离线副本。

所有携带客户端写入的入口，包括 sync step-2 和重连差量，都必须进入同一鉴权、限额、幂等和持久化流程，并为待确认写入建立 updateId。不能直接让通用 readSyncMessage 修改 live Y.Doc 而绕过落盘规则；只读的状态向量查询与正文写入分开处理。

UI 区分“未保存”“本机已保存”“连接中/同步中”“服务端已保存”“权限已撤销”。本地存储失败需要明确提示，不可把仅在内存里的内容标为已保存。

### 4.5 离线与重连

断线后继续修改本地 Y.Doc 并保存 outbox；采用带抖动的重连退避，例如 1/2/4/8 秒到 30 秒上限，可配置。这些是初始工程默认，不是性能实验结论。

重连重新取得 ticket，检查 roomId、epoch、账号和成员资格，再运行完整 Yjs 同步协议交换缺失信息，包括删除信息；随后重传未 ACK 的更新。不能仅比较 state vector 相等就宣布所有本地更新已经持久化。

CRDT 编码快照与 update tail 用于服务端重启恢复。初始可按累计 500 条更新或 1 MiB tail 触发压缩；事务提交新快照及 coveredRevision 后才裁剪旧 tail。幂等回执至少保留到房间生命周期结束，压缩后仍能处理迟到重试。快照必须保存 CRDT 二进制状态，不能只存 toString() 后重新初始化。

权限撤销、房间关闭或 epoch 变化时，禁止直接上传旧 outbox。保留本地草稿，允许导出或新建副本；不得静默丢弃或覆盖新一代文档。新账号登录不自动认领前一个账号的离线更新。

初始保护预算：单 update 不超过 256 KiB，五份源码合计不超过 1 MiB；初次完整同步另设例如 8 MiB 的二进制上限。CRDT 状态还包含历史结构，不能只用当前源码长度判断内存安全。超限明确拒绝并保留草稿；具体值通过负载实验调整，不能静默截断代码。

## 5. 双方编辑如何进入录制包

### 5.1 唯一采集路径

新增 collaborativeRecordingProducer，只在候选人开启录制期间订阅全部五个 Y.Text。它采集“候选人实际观察到的合并后全文”，仍生成 content-change，而不是把 CRDT 私有操作直接写成回放格式。

- 每个 documentId 独立维护 dirty、version、待提交内容及计时器。
- 沿用 300 ms 防抖 + 1000 ms 最大等待：持续输入时最迟约 1 秒提交一次；没有变化时不生成空事件。1000 ms 不是无条件周期快照。
- 运行、暂停、停止、需要一致状态的快照前，flush 全部 dirty 文档，再生成对应事件或快照。
- 协同模式下原 editorProducer 停止采集正文，只保留候选人语言切换、选区、滚动等视图操作，防止 Monaco 和 Yjs 重复记一份变化。
- 面试官修改候选人没有打开的 HTML 标签也必须入包，不能只监听候选人当前 Monaco model。
- 多个文档同一批 flush 时采用固定文档顺序分配 seq；timestampMs 相同仍以 seq 确定顺序。
- 切换文档前先提交或取消旧文档待发的选区/滚动事件，再发 language-change；每条视图事件携带 documentId，避免节流回调迟到后污染新标签的光标或滚动状态。

### 5.2 Schema 0.2.0

协同需要改变正文事件与回放语义，新增 `0.2.0`，不要在旧 `0.1.0` 名下悄悄改变含义。

| 位置 | 拟新增/明确字段 | 语义 |
| --- | --- | --- |
| meta | recordingPerspective: candidate、participants、documents | 单视角录制及文档清单；参与者展示可使用录制内匿名 ID，不默认公开账号 UUID |
| content-change.payload | documentId、可选 actorIds、origin | 标识被修改文档及可获得的来源信息；保留全文、版本和 contentHash |
| ReplayStableState.editor | 文档全集、显式活动文档、当前脚本语言 | 修改未激活文档不改变候选人当时正在看的文档 |
| language-change | 仅表示录制者视图切换 | 不再通过 content-change.language 隐式切换激活文档 |
| selection-change / editor-scroll | documentId | 视图更新写入指定文档；旧包迁移按原事件顺序推导 |
| run-start / 结果关联 | runId、inputDocumentsHash、发起者展示信息（可选） | 固定那次运行对应的输入版本，迟到输出不能冒充当前代码运行结果 |
| ReplayStableState.runtime / 快照 | activeRunId、inputDocumentsHash | 从快照 Seek 后仍能还原输出归属，并判断迟到的运行结果 |

本版 documentId 固定为 `source:<language>`；为减小迁移风险，可以保留旧 fileId 字段但标注兼容用途。以共享包的 types、validators 和 reducer 为唯一实现，不在 Web/API 各定义一份不同语义。

actorIds 仅在可靠获得时记录：一个防抖窗口可能包含多人修改；重连差量也可能混合多个作者。不得把发送这一差量的连接账号当作所有操作的作者。无法归属时写 reconnect/unknown，而非伪造精确审计；本文不承诺逐字符作者溯源。

### 5.3 时钟、暂停与结束语义

例如：候选人在录制第 30 秒断网，面试官第 35 秒修改变量；第 42 秒恢复连接。候选人在第 42 秒观察到合并后的文本，录制事件就记在第 42 秒，不回填第 35 秒。这样代码状态与候选人已录下的声音和画面保持一致。

暂停录制不暂停协作；恢复时先读取所有共享文档，生成 resume-baseline。候选人离线或页面关闭期间，不宣称能够完整录下另一端的操作过程。

停止前 flush，并检查本端 outbox 和连接状态。有未同步状态时提供“等待同步”与“结束当前可见内容录制”选择。即使本端 outbox 为空，也不能证明对端没有尚未送达的离线编辑，因此成品定义仍是候选人视角。已完成录制包保持不可变，迟到协同更新不得回写其历史。

### 5.4 快照与观察流恢复

录制快照继续采用：事件推进时检查距上次快照是否达到 5 秒，或累计 50 条稳定事件，外加暂停、恢复、切语言、运行等语义节点。没有事件时不为了凑每 5 秒而重复复制相同状态；保持现有事件驱动规则并写清楚含义。

DataChannel 保留 seq/hash/buffer/snapshot-request 恢复机制。周期快照和请求快照均由候选人统一状态产生；生成一致状态前先 flush 待录正文，快照带录制 sessionId、覆盖到的 eventSeq。面试官用它恢复“候选人观察状态”，再应用快照之后的缓存事件。

最重要的隔离：面试官的可编辑 Monaco model 不再由 RemoteTimelineBuffer 的 editor.code 直接驱动。快照修复的是观察流，不会覆盖双方的 Y.Doc。CRDT 离线合并靠 CRDT 协议，不靠 seq/hash/完整代码快照。

### 5.5 代码执行的边界

双方都可执行 JS/TS 和 HTML/CSS 组合预览，但正式录制与共享运行面板只采集候选人的运行。面试官的“本地试跑”有独立 runtime instance/runId 与输出面板，不入候选人录制，也不覆盖候选人结果。本版不增加远程命令驱动候选人执行。

点击运行时冻结 JS/TS、HTML、CSS 输入并计算 inputDocumentsHash；候选人先 flush 正文，再发 run-start。代码继续变化时，旧运行输出标注其输入版本，不能错配到新版本。run-output/run-error 必须关联并校验 runId，旧运行的迟到结果不能覆盖新运行；runtime 快照保留这份关联。

保留录制执行 iframe 的 sandbox/CSP 和回放 DOMPurify + 禁止脚本的静态预览。回放恢复保存的运行结果，不重新执行用户代码。现有 iframe 超时机制不能保证同步死循环一定在 3 秒终止；真正可强制终止的计算隔离需后续 Worker/远端沙箱方案，不计入本版承诺。

### 5.6 旧录制兼容

导入顺序必须为：识别原始版本 → 按原版本验证结构与原始 checksum → 迁移成运行时结构 → 回放。现有 integrity 的先迁移再验 checksum 顺序需要调整，不能通过重算 checksum 掩盖损坏文件。

- 新播放器支持 0.1.0 与 0.2.0；旧播放器遇到新包可明确拒绝并提示升级，不承诺双向兼容。
- 旧事件 documentId 从旧 language 和初始文档推导；保持旧 reducer 的视图语义，必要时由迁移适配器显式补齐，而不是直接套用新版行为。
- 原始包只读保留；重新导出才生成新版本及新 checksum。
- ZIP、IndexedDB、云上传 manifest、服务端 validation worker 与播放加载器一起支持版本分派，不能仅更新前端 types。

## 6. 账号、JWT 与资源权限

### 6.1 登录与会话

新增用户名/密码注册、登录和退出；用户 ID 由服务端生成 UUID。密码采用 Argon2id 编码哈希，保存盐及参数，不保存明文或普通 SHA-256 密码摘要；限制输入大小、登录频率，错误提示避免无必要地暴露账号是否存在。

采用 jose 实现标准三段 access JWT。初始配置为 HS256、15 分钟有效期，包含 sub、sid、iss、aud、iat、exp，时间使用秒级 NumericDate。服务端验证固定算法、issuer、audience、过期条件，再查询账号和 session 是否有效；JWT 通过不代表自动拥有任意录制或房间权限。

密钥来自持久服务端配置，正式环境缺失时拒绝启动，不每次进程启动随机换一把。access JWT 仅存 AuthClient 内存，不写 localStorage。

refresh token 使用 32 字节随机 opaque token，数据库存 hash；Cookie 为 HttpOnly、Secure、SameSite=Lax、Path=/api/auth、不设 Domain。初始 session 绝对有效期 7 天，可配置。默认同源部署，本地通过代理；生产必须 HTTPS。

刷新在事务内消费旧 token 并生成新 token，退出撤销 session 并清 Cookie。单页面用 refreshInFlight 合并并发刷新，跨标签页优先用 Web Locks 协调；服务端事务/CAS 是最终保证。刚消费 token 的短暂并发重试返回 409 refresh-raced，不立即撤销所有会话；客户端使用更新后的 Cookie 最多重试一次，超出宽限期的已消费 token 重放撤销 session。响应丢失且无法恢复时重新登录，不无限延长旧 token。

AuthClient 维护 authEpoch；退出/切换账号后，迟到刷新和上传结果不得恢复旧账号状态。login、logout、refresh 使用同一个跨标签页认证互斥流程；409 refresh-raced 响应不清 Cookie。authEpoch 只能保护 JavaScript 状态，不能拦截迟到响应的 Set-Cookie，因此服务端也必须保证已撤销 session 不可重新激活；出现陈旧 Cookie 时重新登录恢复，不赋予其旧会话权限。Cookie 认证接口校验可信 Origin，要求 JSON 和应用自定义请求头；不开放通配 credentials CORS。

### 6.2 API 与权限矩阵

| API/动作 | 要求 |
| --- | --- |
| POST /api/auth/register、/login | 速率与输入限制；成功建立 session |
| POST /api/auth/refresh、/logout | refresh Cookie / session；Origin 防护 |
| GET /api/auth/me | access JWT + 有效 session |
| 本地录制、ZIP 导入导出 | 不要求登录 |
| 云上传、列表、修改、删除、创建/撤销分享 | 登录且录制 ownerUserId 匹配 |
| GET /api/recordings/:id/playback | 登录且有 owner 权限 |
| 有效分享播放 | 分享 capability 授权；不因此获得编辑、删除和转授权能力 |
| 创建协作房间 | 登录；服务端建立 candidate membership |
| 加入房间 | 登录 + 有效邀请；服务端绑定 interviewer membership |
| 修改房间文档 | 有效 session + 编辑成员 + 正确 epoch |

云端 ownerUserId 来自认证上下文，不相信请求中的 ownerId 或录制包作者信息。参与协同编辑不自动成为录制的云端所有者。正式运行时移除 x-owner-token 与旧任意文本换 token 的旁路；JWT 失败不能回退旧匿名身份。

### 6.3 WebSocket 认证

新增 `POST /api/interviews/rooms/:id/ws-tickets`，请求 purpose 为 signaling 或 collaboration。服务端检查账号、session、房间成员与用途，签发 30 秒单次随机 ticket，数据库仅存 hash。

Upgrade 检查 Origin，并在消费 ticket 的同一受控操作中重新检查 session 未撤销、membership 仍有效、房间未关闭，以及 ticket purpose 与实际 WS 端点一致，再原子消费 ticket，绑定 userId、sid、roomId、角色和权限。不能只依赖签发 ticket 时的权限检查，防止签发后注销或被移除仍获取首次同步数据。长效 JWT 不进入 URL；ticket 若在 query 中传递需从访问日志脱敏。后续消息权限来自绑定信息，不相信客户端自报的 role/userId。

重连重新领取 ticket。注销、移除成员或关闭房间时主动关闭关联连接，并在消息处理和定期会话检查时拒绝失效会话。授权不能只在首次握手检查一次。

### 6.4 实际资源下载也必须校验

私有录制的 JSON、WebM 和缩略图都放在非公开目录。新增授权代理：`GET/HEAD /api/playback-assets/:recordingId/:kind?grant=...`。

播放描述接口在验证 owner 或 share 后签发短期随机 grant，例如 5 分钟，数据库仅存 hash，限定录制 ID，关联 sessionId 或 shareLinkId（二选一）。每个 GET、HEAD、Range 请求检查：grant 未过期、录制为 ready，以及关联 session/owner 仍有效或分享未过期未撤销。

支持流式读取和 Range/206；不要每次把整段 WebM 放进服务器内存。播放描述的 expiresAt 与实际 grant 一致；到期后客户端重新取得描述，share 撤销则不再续签。缩略图同样走权限检查。

正式装配禁用旧 `/dev/object-storage/objects/*` 无鉴权下载路径，防止绕过代理。分享明文 token 只在创建时返回，数据库存 hash；owner 可列出分享元信息并撤销。

撤销语义是“后续请求被拒绝”，不是“收回已经下载的字节”；已打开的一次流也不承诺自动抹除浏览器缓存。代理响应采用私有、受控缓存策略；日志隐藏 grant/token，设置严格 Referrer-Policy。

### 6.5 上传同样属于权限闭环

上传会话由登录账号创建，绑定 recordingId、资产清单、大小、hash、过期时间及 owner。PUT 上传凭据只能写指定会话和资产，不能自行提供任意磁盘路径。

复用现有校验与 ready/failed 状态机。服务端实际读取字节验证大小、类型、checksum 和包约束；未验证资产不得用于分享播放。账号切换后暂停旧上传，要求重新选择账号，不将 A 的待上传记录无提示归到 B。

## 7. 持久化与迁移

### 7.1 最小数据模型

默认一个 SQLite 数据库，启用外键、迁移版本、事务和 WAL；通过 repository 接口接入。初版可用 better-sqlite3，锁定兼容当前 Node 的版本并验证部署原生依赖，不为换数据库重写业务服务。

| 表/数据集 | 关键字段 |
| --- | --- |
| users | id、usernameNormalized UNIQUE、passwordHash、displayName、disabledAt |
| sessions / refresh_tokens | sessionId、userId、expiresAt、revokedAt；tokenHash、consumedAt、replacedBy |
| interview_rooms / room_members | roomId、ownerUserId、epoch、status；userId、role、permission |
| room_invites / ws_tickets | tokenHash、房间、用途/角色、expiresAt、consumedAt |
| collaborative_documents | roomId、epoch、encodedState、coveredRevision |
| collaborative_updates / receipts | revision、updateId、updateHash、bytes；幂等回执 |
| recordings / recording_assets | 云端 ownerUserId、状态、schemaVersion；kind、私有 key、hash、bytes |
| upload_sessions / validation_jobs | 所属用户、资产计划、幂等键、状态、任务重试信息 |
| share_links / playback_grants | tokenHash、recordingId、有效期/撤销时间；授权来源 |

服务端启动恢复元数据、协同快照及 tail，继续可重入的校验任务。媒体写入私有临时文件，完成校验后原子移动到稳定 key；数据库记录状态。文件与数据库不是同一事务，必须有 staging/ready 状态及孤儿文件清理，不能先宣称 ready 再异步写文件。

备份同时覆盖数据库与录制资产，并记录快照时间；上线前做一次恢复演练。首版单实例，不允许多个 API 进程各持有同房间独立状态却没有广播总线。

### 7.2 旧数据策略

旧设备 token 不足以证明新账号身份。默认迁移路径为保留本地 IndexedDB/ZIP → 用户登录 → 明确上传到账号；不支持传 oldOwnerId 就自动认领旧云录制。

如已有 demo 云数据需要保存，上线前停止新上传并导出内存元数据和媒体，再重启服务。历史归属仅通过管理员核实的映射或预登记、一次性、限时的专用迁移凭据导入；不能通过旧开放 token 接口临时生成“身份凭证”。

默认旧分享失效，由 owner 在升级后重建。旧上传会话关闭并提示重传。归属迁移只改外部云元数据，不改原包事件、meta 或 checksum；无主旧数据保留在受限区域，不自动公开。

## 8. 事件时间轴与回放优化

### 8.1 真正的事件虚拟列表

保留底部 Slider，新增右侧“事件”面板。默认显示编辑、运行、错误、快捷键、章节等重要事件，可切换全部事件并按类型筛选。列表条目只保存 id、seq、timestampMs、类型、文档、短摘要及原事件索引，不复制整份代码。

使用固定 48px 行高；长内容省略，详情在独立区域展示。滚动容器有完整 `count × 48px` 占位高度，只挂载可视索引与前后各 5 行 overscan。ResizeObserver 测量容器，滚动更新按动画帧合并；挂载行数上限约 `ceil(viewportHeight / 48) + 12`。

排序、筛选和摘要在包加载或条件变化时计算；播放 tick 只二分定位活动行。筛选仅改变展示，不删除 scheduler 中的原事件。用户手动滚动时关闭跟随，点击“回到当前”恢复；仅当活动行超出视区才滚动。

键盘上下、Home/End 基于逻辑索引，先 scrollToIndex 再聚焦；提供 aria-posinset/aria-setsize。虚拟行卸载不能让焦点无处可去。若显示活动密度，用有限桶或 canvas，不为每条事件创建一个 DOM marker。

行点击执行时间 Seek；同一毫秒有多条事件时恢复该毫秒全部事件后的状态，按 seq 排序。第一版不声称可暂停在同毫秒中间某一个事件；如果后续需要逐事件调试，应单独定义 seekBySeq。

### 8.2 索引与重建

复用 replayIndex 的快照/事件索引。定位目标时间的最近快照后，用 upperBound(snapshot.eventSeq) 找到稳定事件起点，只重放快照后的事件；避免从事件数组头开始扫描再跳过。正常播放沿用游标前进，不每帧重新构造全量状态。

索引构建允许 O(N)，Seek 状态重建目标为 O(log S + log N + K)，S 为快照数量，K 为快照后需重放事件数。K 不能简单等同于 50，因为稳定事件与全部事件、语义快照及时间条件不同。虚拟列表也不降低完整事件 JSON 的加载内存，应同时限制事件数、源码尺寸和包大小。

本版保持现有云端预算：15 分钟、20,000 条事件、媒体 200 MiB、总资产 250 MiB。2,000+ 是典型演示规模，不是新的硬上限；超现有预算的样本用于验证拒绝，不声称支持。

### 8.3 连续 Seek 的最后一次生效

为播放器引入 packageGeneration 和递增 seekGeneration。Slider、事件行、字幕、章节全部调用同一个 seek controller。

每次 Seek 捕获 generation；在媒体加载、seeked、状态提交、恢复播放、Monaco 更新和字幕 decoration 等异步边界检查是否仍为最新。旧请求返回 superseded，不提交状态、不恢复播放、不执行代码定位。

取消旧监听/计时器；共享 video 元素的 currentTime 修改由媒体适配器统一调度，陈旧 seeked 事件不能完成新请求。无法中止底层加载时允许其结束，但禁止影响当前状态。切换录制包或卸载也使旧请求失效。

## 9. AI 字幕与代码定位

### 9.1 保留现有模型路线

ASR 继续通过 Transformers.js 在浏览器加载 `onnx-community/whisper-tiny` 并使用 WASM；保留中文转写、时间戳、30 秒块和 5 秒重叠等现有配置。

LLM 后处理与 ASR 分离：默认沿用浏览器本地模型配置 `ceilf6/code-tape-subtitle-postprocessor-onnx`，通过现有 Worker 客户端执行；外部 LLM 沿用配置适配器。不是必须安装一个本地服务器，也不是把 Whisper 当作纠错 LLM。

外部模型使用前明确告知会发送字幕及裁剪后的代码上下文；默认不把 API key、原始字幕/源码或音频放进应用日志。外部 API key 维持用户自配模式，本轮可把持久保存改为显式勾选，默认仅当前会话，不引入平台代付或共享密钥。

### 9.2 返回校验与降级

沿用并加强结构化校验：JSON/字段类型、允许的 segment ID、ID 唯一性、文本长度、章节起止时间和 duration 边界。纠错结果只允许修改原字幕 ID 对应的 text，不能任意增删 ID 或改变 ASR 时间；需要分块的派生结果必须显式维护源 segment 映射与连续时间范围。

模型不得修改事件、代码、checksum、权限或 code anchor。提交策略明确为：某批字幕纠错存在非法 ID/重复 ID/空文本时，拒绝该批纠错并保留原文；章节单独校验，章节失败不撤回已通过的文本纠错，也不抹掉成功的 ASR。未被模型返回的原字幕保持不变。取消或过期任务不覆盖用户较新编辑，以 recordingId + trackRevision + taskGeneration 防止竞态。

本版“字幕分块”指长字幕轨道的处理批次：默认最多 60 个原 segment 一批，同时受模型输入预算限制，超预算继续拆小批；每批保留原 ID 和时间戳，按原顺序合并纠错结果。章节候选在批次内限制时间范围，合并后按时间排序、去重并校验不重叠；失败保留原章节并显示警告。它不代表新增词级强制对齐，也不通过均分时间凭空制造精确字幕时间戳。

### 9.3 历史代码上下文

现有后处理上下文主要来自当前回放视图。升级为按字幕处理窗口解析历史状态：例如 30–60 秒字幕使用该区间代表性代码、相关运行输出及术语表，不直接取用户此刻停在 5 秒看到的代码。

新增 contextResolver，复用回放索引并设字符预算，代码和输出先沿用现有 6,000/2,000 字符上限，术语暂限 100 个，参数可调整；还需按实际 tokenizer 估算输入 token，预留输出与系统提示空间，超过模型上下文预算时进一步裁剪。按文档和变化摘要选取内容，不把整个录制包扔给模型；长字幕分批处理，失败可重试当前批次。上述预算是初始限制，不是模型效果实验结论。

### 9.4 可校验的代码 anchor

anchor 属于字幕派生资产，不进入录制事实事件，也不因重新生成字幕修改原包。拟定结构：

```ts
type SubtitleCodeAnchor = {
  segmentId: string;
  targetMs: number;
  eventSeq: number;
  documentId: string;
  contentHash: string;
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  source: "recorded-selection" | "recorded-cursor" | "manual";
};
```

整个 anchor 资产还保存 recordingId、sourceEventsChecksum、subtitleTrackRevision。默认 targetMs 为字幕开始时间；从该时间实际恢复的历史状态取活动文档、有效选区或光标及 hash。没有可靠范围时保留时间跳转，不猜一个函数行号。

生成时对字幕与事件按时间单次归并扫描，或点击时按快照惰性计算；不能每条字幕从事件头重放一次，也不为每条字幕复制整份源码。相同时间戳遵守播放器的 seq/时间语义。

点击顺序：提交 Seek → 确认最新请求完成 → 确认文档和 hash 匹配 → 校验 range 不越界 → revealRangeInCenter + 短时高亮。定位装饰只影响查看者 UI，不写回录制 cursor/selection 或生成事件；用户跳到别处后旧定位不再生效。

字幕时间被编辑、事件 checksum 不同或 trackRevision 变化时使自动 anchor 失效并重建；纯文本纠错不改时间时可以保留已验证的定位。手动 anchor 保留显式关联，失效时提示重新关联。

本版优先将 anchors 与字幕/章节原子保存到现有字幕 IndexedDB，升级其存储版本。ZIP/云端字幕侧车导入导出可作为后续独立能力，本版分享链接只保证录制播放，不承诺自动携带本地生成的字幕；共享端可重新生成。避免为这个需求无谓改变主包校验范围。

### 9.5 字幕列表与预热

字幕列表第一版使用固定 72px 双行预览，完整文本在选中详情/编辑区展示，以复用定高虚拟化；宽度变化仍保持固定行高。当前字幕通过归一化后的时间索引查找，使用 scrollToIndex，不能依赖未挂载行的 scrollIntoView。存在重叠区间时明确优先级或归一化，不能直接假设任意区间都适合简单二分。

预热条件改为有音频、字幕功能可用、页面空闲或用户明确即将生成；不在首页或无音频回放强制下载模型。先 ASR，后 LLM，避免并发加载大模型抢占资源。缓存 pipeline/Worker 初始化 Promise，失败清理可重试；只取消未开始的空闲任务，不声称必然中断所有已进入的 WASM 调用。失败不阻断录制与回放。

## 10. 拆包与加载策略

- `app/routes.tsx` 改为页面级动态 import，录制、回放、面试、账号页面独立加载；提供加载占位及 chunk 加载失败重试。
- 保持 Monaco、TypeScript、Prettier、Transformers 和 LLM Worker 的按需加载及 Promise 复用，不为首页静态依赖链提前加载。
- 录制页需要编辑器，应尽快并行启动编辑器代码和必要初始化，不能为了 LCP 把真正可用时间无限后移。
- AI 模型资源与应用 shell 分开缓存，区分 SDK、模型权重、WASM、Worker 初始化与第一次推理耗时。
- 记录 editor-ready、replay-ready 和 route-ready 等业务指标，避免“LCP 更快但编辑器更晚能用”的假优化。

## 11. 测试规划：覆盖风险，不凑数量

复用现有 Schema、API、Web 单元/组件测试和 Playwright。新增测试数量由场景决定，不要求达到或维持简历里的特定总数；最终报告从实际命令输出统计通过、失败、跳过，不能把计划用例算成已通过。

### 11.1 分层清单

| 层级 | 必须覆盖的行为 | 核心断言 |
| --- | --- | --- |
| Schema/纯函数 | 多文档更新、0.1.0 迁移、快照恢复、hash、同毫秒事件 | 未激活文档不切视图；原包先验完整性；重建状态一致 |
| 协同单元 | 重复/乱序更新、删除、epoch、outbox、ACK 丢失、压缩 | 合并后文本一致；未 ACK 不报已保存；同 ID 不同内容拒绝 |
| API 集成 | 登录/refresh 并发、退出、账号切换、owner 越权、房间人数、ticket 复用 | 未授权无数据泄露；撤销 session 后 API/WS 不可继续使用 |
| 存储集成 | 服务端重启、update 提交后崩溃、校验任务恢复、半完成文件 | ACK 内容重启后可恢复；未验证文件不可被分享读取 |
| 资产安全 | GET/HEAD/Range、thumbnail、过期/撤销分享、旧下载路由 | 实际字节入口受权限保护，不只是播放描述接口 |
| Web 组件 | 虚拟行数量、筛选、键盘焦点、跟随、字幕列表 | DOM 数量随视口而非事件总数增长；定位与展示正确 |
| Seek | 慢媒体、连续正反向 Seek、切换包、旧模型任务完成 | 只有最新 generation 提交状态/播放/高亮 |
| AI 逻辑 | 非法 JSON、重复 ID、越界章节、取消、错误上下文、失效 anchor | 保留有效原字幕；不改录制事实；历史文档/hash 匹配 |
| 浏览器 E2E | 双人编辑、断线重连、录制导出回放、登录分享、资源撤销 | 以可见 UI、真实服务端持久化和回放状态验证整条链路 |

不把所有异常都放进慢 E2E：协议乱序/重复在 provider/receiver 层注入验证；正常 DataChannel 有序可靠，不把单元故障注入描述成浏览器日常必然乱序。

### 11.2 代表性 Playwright 场景

**场景 A：双方离线编辑后合并，刷新仍保留。**

1. 启动隔离的真实 API、临时 SQLite/私有目录，创建两个浏览器 context 与账号；关闭真实 AI 预热，避免网络模型下载干扰。
2. A 建房，B 用邀请加入，等待两端显示已同步；通过编辑器输入辅助函数操作实际 Monaco，不直接修改 Y.Doc 来冒充用户编辑。
3. 通过测试专用服务端故障开关断开 B 的 collaboration socket，并阻止其重连。仅 setOffline 不足以证明既有连接已关闭，需要等待 UI 离线状态与服务端连接断开记录。
4. A 与 B 分别编辑互不相同的代码位置；断线期间断言各自新内容本地可见、B 显示“本机已保存”而不是“服务端已保存”。
5. 恢复连接并等待合并，断言两端全文完全相同且两项修改都存在，outbox 清空并出现持久化确认。对“同一位置同时插入”的单独场景断言确定性收敛，不臆定用户语义结果。
6. 刷新 B，再重启 API 后重新进入房间，断言代码未丢、权限仍有效。

故障开关只能在测试服务器启用，不向生产暴露未认证调试接口。测试使用 auto-wait/expect.poll 等等待条件，不依赖大段固定 sleep。

**场景 B：面试官修改未激活 HTML，候选人录制仍可回放。**

候选人停在 JS 标签录制，面试官编辑 HTML；断言候选人 JS 标签不被强制切走。停止并导出 ZIP，再导入回放，在对应时间恢复 HTML 内容，同时候选人视图仍为 JS；运行输出与输入 hash 一致。这样验证的是“协同 → 采集 → 包 → reducer → UI”，而不只是两个编辑器看起来相同。

**场景 C：拖动两次进度条，旧 Seek 不能覆盖新结果。**

让第一次媒体 Seek 延迟，再触发第二次；断言最终时间、代码、活动字幕和高亮均对应第二次，旧请求结束后保持不变。另覆盖 Seek 期间切换录制包。

**场景 D：分享撤销不只影响页面入口。**

owner 上传并分享，未登录 context 正常播放；缓存一个媒体 grant URL 后撤销分享，再请求播放描述、媒体 Range 和缩略图，均应拒绝；不能仅断言页面出现“分享已失效”。已下载字节不作为撤销失败判据。

### 11.3 运行方式

每个实施阶段先运行相关模块测试，交付前按仓库既有流程执行 Schema/API/Web、构建和 E2E。现有 `quality:ci` 等门禁不因本 Spec 而删减。接入真实模型的 smoke/效果评估单独运行；日常 E2E 用固定 ASR/LLM 返回测试 UI 与校验，不把模型随机输出作为稳定断言。

## 12. 性能测量与目标

### 12.1 先记录环境，再谈提升

性能脚本使用生产构建和静态服务/preview，不拿 Vite dev server 结果当生产 LCP。保留功能 E2E 配置，新增独立的 perf 配置及报告脚本。

每份报告记录 commit、lockfile、Node/Chromium、操作系统/硬件、电源模式、视口 1440×900、DPR 1、服务器部署位置、数据集 checksum、缓存状态及资源字节数。单 worker、前台窗口，不并发构建或跑模型。

至少分两组：桌面不节流；受限桌面，例如 CPU 4×、网络 10 Mbps/RTT 100 ms。这些是固定实验条件，不代表所有用户。冷缓存与暖缓存分开；新 context/清缓存用于冷启动，同 context 第二次硬导航用于暖启动。

### 12.2 数据集

使用固定 seed 生成合法 2,000 / 10,000 / 20,000 事件包，时间跨度在现有 15 分钟预算内，包含编辑、运行、选区、同毫秒事件、章节及按真实规则生成的快照。记录事件分布、稳定事件数、源码大小、实际包体积。

源码约 2 KiB 与约 20 KiB 分档，但只有满足实际 JSON/媒体/总预算的组合进入支持范围，不能假定 20,000 条全文事件全部使用大源码仍能通过总预算。另准备非法超预算样本验证拒绝。

纯事件与固定合法 WebM 分开测量；有媒体样本的 duration/timelineOffset 必须匹配。字幕样本覆盖长短中英文混排。A/B 使用同一数据集、同一随机 Seek 目标和滚动轨迹。

### 12.3 对照实验

| 实验 | 对照组 | 改进组 | 测什么 |
| --- | --- | --- | --- |
| 路由与重资源加载 | 当前生产构建 | route lazy + 条件预热 | LCP、editor-ready、replay-ready、请求与初始 JS 字节 |
| 事件列表虚拟化 | 同一新列表的实验专用全量渲染模式 | 相同内容虚拟渲染 | 挂载耗时、DOM 行数、长任务、滚动 trace |
| Seek 索引 | 原从头扫描跳过 | upperBound 后局部重放 | 扫描/应用事件数、状态重建与代码呈现时间 |
| 快照生成策略 | 例如 2s/20、5s/50、10s/100，保持语义快照一致 | 同一数据/目标分别运行 | 快照数、包增量字节、录制构建成本、Seek p95 |
| AI 加载 | 冷启动、无预热 | 条件预热后复用 | 下载、初始化、首个可用结果、内存峰值 |

旧版只有 Slider，没有事件长列表，因此不能拿旧 Slider 与新虚拟列表直接比较后声称“列表优化”。全量/虚拟对照应是同一种列表 UI。快照实验阈值均指 OR 规则且在事件推进时检查，不是精确时钟采样。

导航每个版本至少 10 个样本，交替 A/B，保留原始结果并报告中位数与实验 p75；小样本仅用于趋势判断。Seek/滚动预热后收集例如 100 个固定操作样本，报告 p50/p95/max；失败和离群单独标注，不只选最好一次。

### 12.4 LCP 的正确口径

分别对 `/`、`/record`、固定回放页做硬导航；在计时外准备录制数据，但不预热应用 bundle。导航前注入 PerformanceObserver，观察窗口内不输入/滚动，固定观察例如 10 秒并确认业务 ready，记录最后一个 LCP candidate 及对应元素；页面未就绪记为失败。

SPA 内部切路由另报 route-ready，不冒充新的标准导航 LCP。LCP 与 editor-ready/replay-ready 同时看，避免仅通过延迟主要交互能力改善单一数字。模型生成流程单独测，不计成首屏体验。

行业的 LCP 2.5 秒参考通常结合真实用户第 75 百分位；本文的实验样本 p75 不等于线上用户 p75。相关口径依据 [web.dev LCP 文档](https://web.dev/articles/lcp)。

### 12.5 初始预算，不是已经达成的成绩

| 指标 | 初始参考目标/判定方式 | 是否首版硬门禁 |
| --- | --- | --- |
| LCP | 受限桌面实验可先参考 p75 ≤ 2.5s，测基线后修订 | 否；不强制 3.2s → 2.1s |
| editor-ready / replay-ready | 不因拆包显著变慢；相对回归同时超过 10% 且 100ms 时告警 | 先告警，稳定环境后再定门禁 |
| 事件 DOM 行数 | 48px 行高时 ≤ ceil(H/48)+12 | 是，确定性检查 |
| Seek 状态重建 | 桌面 2k 合法包初步参考 p95 ≤ 50ms | 先测量再确认 |
| Seek 代码可见 | 同环境初步参考 p95 ≤ 100ms，媒体延迟单列 | 先测量再确认 |
| 20k 包 | 在字节预算内能加载、筛选、定位且状态正确 | 功能是门禁；耗时先报告 |
| 数据一致性与安全 | 不丢已 ACK 更新、最后一次 Seek 生效、无越权读取 | 是，不因性能预算放宽 |

Seek 分别打点 state-rebuild、Monaco model applied、后续绘制机会、media seek start/seeked；Promise 返回不代表代码已经绘制。滚动记录长任务、帧间隔和 trace，不把 requestAnimationFrame 回调数等同于实际渲染 FPS，也不承诺所有设备恒定 60fps。

报告保存环境、原始 JSON/CSV 和结论。若基线已很好，允许目标改为避免回归；若提升不显著，就如实描述，不为了简历数字修改实验条件。CI 初期检查确定性约束与严重退化，统计性能用独立任务观察，稳定后再逐步设阈值。

## 13. 实施阶段与文件落点

本节文件为现有修改点或拟新增位置，实施时按现有导出/依赖组织调整，不要求机械按名字创建空壳抽象。

| 阶段 | 主要工作与落点 | 完成条件 |
| --- | --- | --- |
| P0：范围生效 | 更新 PRD、技术方案、ADR；固定测试数据和测量口径 | 双写/录制边界获确认，基线报告可复现 |
| P1：持久化与账号 | 新增 API auth、SQLite repositories、私有 object store；改 authTokenService、cloudApiHandler、demoServer 装配；新增 Web auth | 登录/刷新/退出，重启数据可恢复；移除匿名旁路 |
| P2：云资源权限 | 改 cloudRecordingService、interviewApiHandler、signaling upgrade；新增 playbackAssetHandler、邀请/ticket | owner/分享/媒体 Range/WS 权限闭环，撤销有效 |
| P3：协同正文 | 新增 Web features/collaboration；改 CodeEditor 和双方页面；新增 API collaboration server/repository | 两端并发和离线收敛，持久 ACK、刷新和重启恢复 |
| P4：录制兼容 | 新增 collaborativeRecordingProducer；改 editorProducer、packageBuilder、snapshotBuilder、interviewSync/receiver；升级共享 types/validators/replayState/migrations/integrity | 未激活文档入包；单时间轴确定性；旧包兼容 |
| P5：回放与虚拟列表 | 新增 ReplayEventTimeline、replayTimelineModel、定高虚拟化 hook；改 replayIndex/scheduler/ReplayPage | 2k+ 事件列表、连续 Seek、正确高亮；DOM 有界 |
| P6：字幕增强 | 新增 subtitleCodeAnchors/contextResolver；改 SubtitlePanel、subtitleStore、postprocessor 输入与预热 | 历史上下文、可靠定位、非法输出及过期任务不污染数据 |
| P7：加载与验收 | 改 routes.tsx；补关键测试；新增 perf 配置与报告；迁移/回滚演练 | 完成功能矩阵、得到真实测量结果后定版 |

P3 依赖 P1/P2 的账号、房间与 WS 权限；P4 的 Schema 评审可提前，但录制桥接需要 P3。P5、P6 可在数据契约冻结后并行。每阶段保持非协同录制/回放可用，不把全部功能塞进一次不可回退的大改动。

主要现有路径：

- `apps/web/src/features/editor/CodeEditor.tsx`
- `apps/web/src/features/interview/CandidateInterviewPage.tsx`
- `apps/web/src/features/interview/RemoteInterviewWorkbenchPage.tsx`
- `apps/web/src/features/interview/interviewSync.ts`
- `apps/web/src/features/interview/remoteInterviewWorkbench.ts`
- `apps/web/src/features/capture/editorProducer.ts`
- `apps/web/src/features/recorder/packageBuilder.ts`
- `apps/web/src/features/recorder/snapshotBuilder.ts`
- `apps/web/src/features/player/replayIndex.ts`
- `apps/web/src/features/player/replayScheduler.ts`
- `apps/web/src/features/subtitles/SubtitlePanel.tsx`
- `apps/web/src/features/subtitles/subtitleStore.ts`
- `apps/web/src/features/cloud/cloudRecordingRepository.ts`
- `apps/api/src/http/cloudApiHandler.ts`
- `apps/api/src/http/localDevObjectStorageHandler.ts`
- `apps/api/src/cloud/authTokenService.ts`
- `apps/api/src/cloud/cloudRecordingService.ts`
- `apps/api/src/demo/demoServer.ts`
- `packages/recording-schema/src/`

## 14. 上线、回滚与可观测性

协同编辑、虚拟列表、字幕定位分别设置发布开关。新协同关闭后可以退回候选人观察模式，但必须保留 Yjs 本地草稿和服务器持久数据，不能清库回滚。若回退应用不支持 0.2.0，应阻止新包写入并保留兼容读取服务；不把新包降版本后交给旧代码。

数据库迁移先备份，优先添加式变更；先完成旧数据导出，再替换内存装配。首批以两个测试账号验证，再逐步开放。登录和资源保护上线后，不以“回滚”为由重新开放旧匿名越权路径。

结构化日志至少包括 requestId、roomId、sessionId、connectionId、epoch、updateId、persistedRevision，以及录制观察流的 recordingSessionId、seq、expectedSeq、lastAppliedSeq、快照 seq、seekGeneration 和 packageGeneration。默认不记源码、字幕全文、密码、token、grant 或 API key。

排查时区分“客户端生成”“本地持久化”“socket.send 调用”“服务端收到”“服务端持久化 ACK”“对端应用”“UI 呈现”。send 返回或出现序号缺口都不足以单独证明网络丢包；定位必须逐段对同一 updateId/seq 查证。协同一致性与录制观察流一致性分别记录，避免混淆。

## 15. 完成定义与简历表述边界

本升级完成需满足：

1. 双方可实际同时编辑，离线修改能够合并；已确认持久化的数据经刷新和服务器重启不丢失。
2. 录制包包含候选人观察到的双方正文变化，旧包仍可读，回放无需执行 CRDT 或重新运行代码。
3. 时间轴真实虚拟化；2,000+ 合法事件可操作，连续 Seek 不被旧结果覆盖。
4. 真实账号登录和 JWT 会话可用；云录制、分享、下载、WS 的权限一致且可撤销。
5. ASR 和 LLM 链路仍可用；字幕能够按历史状态定位，有可靠范围才高亮，失败可降级。
6. 核心风险场景有实际通过的测试报告，性能有原始数据和实验环境，不用虚构数量和耗时证明效果。

届时可表述为“基于 CRDT 实现双人协同及离线合并，通过序号、哈希与快照恢复录制观察状态”。不应只写“序号 + Hash + 周期快照解决双方冲突”，因为它们并不负责 CRDT 合并。

“多语言”需限定 JS/TS 与 HTML/CSS，Python 仍不能运行；“字幕代码定位”表示历史状态/光标/选区关联，不等于自动理解每句话提及的函数；“LCP 提升”和“测试通过数”只能替换为实施后真实测得的结果。

## 16. 设计参考

- [Yjs Document Updates](https://docs.yjs.dev/api/document-updates)：CRDT 二进制更新及状态同步接口。
- [Yjs WebSocket provider](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket)：中心服务同步方式；应用的 durable ACK 是本 Spec 额外设计。
- [y-monaco](https://github.com/yjs/y-monaco)：Monaco 与 Y.Text 的绑定。
- [Yjs Relative Positions](https://docs.yjs.dev/api/relative-positions)：协同位置表示。
- [jose](https://github.com/panva/jose) 与 [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)：标准 JWT 实现与验证边界。
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：密码存储。
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)：多 context、离线等浏览器测试能力；协议故障需由测试环境另行控制。
- [web.dev LCP](https://web.dev/articles/lcp)：导航指标、候选元素与实验/真实用户口径。

库的具体安装版本在实施时核对当前项目的 Node、React、TypeScript 和浏览器支持后锁入 lockfile；本文不以未经验证的最新版版本号作为依赖要求。
