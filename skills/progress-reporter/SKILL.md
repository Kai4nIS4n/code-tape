---
name: progress-reporter
description: "读取 code-tape 项目 progress.md，将 GitHub ID 映射为同学姓名，生成格式化进展报告并发送到飞书群聊。"
---

# Progress Reporter

将 `docs/progress.md` 中的团队进展数据转换为可读的中文报告，发送到飞书群聊。

## 触发词

"发送进展"、"进度报告"、"群发进度"、"send progress"、"发到群聊"、"汇报进展"

## 工作流程

### 1. 读取进展数据

读取 `docs/progress.md`（相对于项目根目录 `Desktop/code-tape`）。

### 2. 映射 GitHub ID → 姓名

使用 `references/name-mapping.md` 中的映射表，将 GitHub 用户名替换为中文姓名。

未在映射表中的 GitHub ID 保持原样不替换。

### 3. 生成格式化报告

将 `progress.md` 的三个表格转换为自然语言摘要：

#### 报告模板

```
📊 code-tape 训练营进展报告
更新时间：{更新时间}

🏃 当前任务
• {姓名} — {issue 标题}
• {姓名} — {issue 标题}

🏆 积分总览
• {姓名}：总分 {总分}（开发 {开发分} / CR {CR分}）
• {姓名}：总分 {总分}（开发 {开发分} / CR {CR分}）

📝 最近动态
• {时间} — {描述}（{涉及人员及分数变化}）
```

格式要求：
- 时间转换为北京时间（+8），格式 `MM-DD HH:mm`
- 分数只在非零时显示
- 没有当前任务时显示"暂无认领中的任务"
- 没有流水时显示"暂无最近动态"
- 未映射的 GitHub ID 原样保留

### 4. 发送到飞书群聊

使用 `sessions_send` 工具发送报告。需要目标群聊的 session 标识。

如果用户未指定目标群聊，询问用户：
1. 提供飞书群的 chat_id 或 session key
2. 或者让用户将 bot 添加到目标群后，通过 `sessions_list` 查找对应 session

发送时直接使用报告文本作为 message 内容，无需额外包装。

## 注意事项

- `progress.md` 由 GitHub Actions 自动生成，格式固定，无需容错处理
- 报告语言为中文
- 分数为 0 的字段在报告中省略，保持简洁
- 更新时间使用 progress.md 中的原始 UTC 时间转换
