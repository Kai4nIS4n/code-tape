# 文档
1. docs/PRD.md 文档的权威性是最高的
2. 提交的代码不准背离 docs/技术方案.md 。若认为技术方案有任何错误，应通过 discussion 及时上报仓库维护者

# 工作
1. 每次开始任务前运行轻量检查 `npm run quality:predev`；只检查 hooks 是否安装，不刷新 GitNexus，不重复写已有 Git 配置
2. 首次使用新的 checkout 且未安装 hooks 时运行 `npm run agent:bootstrap`；已安装无需重复初始化
3. 创建分支以 feature/ , fix/ 或 chore/ 开头
4. 使用 Karpathy Guidelines 技能确保代码改动的高质量、精确性
5. 前端 UI 设计使用 frontend-design 技能
6. 启动本地 web dev server 必须用 `npm run dev`
7. 修改回放核心、Schema、运行时或存储等关键模块时检查调用者、兼容性和相关测试；复杂改动可按需运行 `npm run contract:local` 并阅读 GitNexus 的建议。GitNexus 不作为开发前、提交或 CI 的必跑工具；推送前和 CI 保留 `contract:check` 的测试与影响摘要检查
8. 后续升级的提交、推送及 PR 默认目标为用户自己的 `Kai4nIS4n/code-tape`，PR 的 base repository 必须显式指定该仓库；未经用户要求，不向上游创建 PR 或推送。等待该 fork 的 GitHub Actions 并审查实际出现的评论；个人升级不依赖上游的认领、计分或维护者确认流程
