# 高考数学题库与自动质检组卷

这是一个独立的 Codex skill 与本地工作台，用于长期维护高中数学题库、配对试卷与答案，并按学生水平和课堂形式生成 Word/PDF 试卷。

## 功能

- 支持 PDF、DOCX、Markdown、TXT、图片和 ZIP 等来源。
- 每个压缩包形成独立资料包，题卷、答案、解析和评分标准分别保存。
- 题目按 L1–L5 能力档及 0–150 分制目标分组织。
- 支持一对一教学卷、45 分钟班课卷和新高考完整考试卷。
- 学生卷与教师卷分开生成，正式题必须有可靠答案并通过结构门禁。
- 题库索引、重复检测、逻辑排除、快照和历史输出均保留。

## 自动质检

设置页中的“题库健康检查”支持定时、小批次和断点续跑：

```text
确定性检查与修复
  → 本地 Ollama
  → 两次独立线上复核
  → 人工
```

- 本地模型不可用、超时、低置信度或结果可疑时立即升级线上。
- 第二遍线上复核不读取第一遍答案，两次一致才自动修改题库。
- 两次冲突、均无法判断或线上连续失败时才进入人工。
- 普通题和 AI 答案按复检周期轮转，刚验证过的题不会重复调用模型。
- 每轮和每个处理阶段均有状态、日志、分类统计和失败重试记录。

默认配置位于 `gui/config/models.json`：

- 24 小时巡检一次。
- 每批最多 8 道题，可在设置页调整为 1–30 道。
- 本地模型超时 20 秒。
- 线上每遍最多重试 2 次。
- 普通题 7 天后复检，人工题 30 天后重试。

## 启动

需要 Windows、Python 3.10+、Node.js 和可选的本机 Ollama。

```powershell
powershell -ExecutionPolicy Bypass -File .\gui\setup.ps1
.\启动高考组卷.cmd
```

也可以直接使用 Codex skill：

```text
使用 $gaokao-math-paper-builder 帮我管理题库并生成班课小卷
```

## 本地数据

运行时会在本目录创建：

```text
bank/
  sources/      原始来源
  items/        结构化题目
  packets/      资料包和题答链接
  backups/      快照
outputs/        生成的试卷
gui/jobs/       任务状态与日志
```

这些目录含个人教学资料和较大文件，已通过 `.gitignore` 排除，不会上传 GitHub。

## 验证

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe scripts\paperbank.py validate
node --check gui\server.mjs
node --check gui\public\app.js
```

当前版本通过 33 项自动化测试，并由 `paperbank.py validate` 校验题库结构。

详细规则见 `SKILL.md`、`references/model-routing.md` 和 `references/operations.md`。
