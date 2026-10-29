# 运维、备份与恢复

## 本地窗口

双击根目录的 `启动高考组卷.cmd`。首次运行可执行 `gui\setup.ps1` 安装固定版本依赖。窗口服务只监听 `127.0.0.1`。

窗口右侧的资料库页面是日常文件管理入口。原始文件按哈希保存在 `bank/sources/`，不要通过手工重命名内部目录来整理资料。使用“打开原文件”和“查看文本”定位来源。

## 自动入库

“保存到资料库”会调用：

```powershell
py scripts/paperbank.py import-upload-batch --request request.json --output result.json
```

每个压缩包形成独立资料包，题卷自动拆为草稿题。配对答案后使用：

```powershell
py scripts/paperbank.py process-packet <packet-id>
```

## 备份

导入、重新定档和结构升级前使用：

```powershell
py scripts/paperbank.py snapshot
```

快照包含题目、资料包清单、配置和校验和，不重复复制大型原始来源。完整备份使用 `--full`。

## 定时质检

设置页的“题库健康检查”控制定时计划。窗口运行时每 15 分钟检查一次是否到期；默认每 24 小时运行，启动时如已到期会补跑。任务只串行执行，关闭设置页不影响后台继续。

单轮流程：

1. 检查索引、结构、答案、媒体、重复项和旧拆题版本，并先做确定性修复。
2. 按每题上次检查时间选出有界批次，本地 Ollama 先跑。
3. 本地不可用、超时或结果可疑时，立即进行两次彼此独立的线上复核。
4. 两次结论一致才自动更新或补答案；不一致、无法判断或线上连续失败才进入人工。

批次、普通复检间隔、人工题重试间隔、本地超时和线上重试次数均可在设置页修改。任务写入 `gui/.runtime/audit-state.json`，详细阶段和日志写入对应的 `gui/jobs/QUALITY-*` 目录。失败任务默认 1 小时后可再次运行，不会等待完整周期。

## 恢复

先停止窗口任务，再执行：

```powershell
py scripts/paperbank.py restore bank\backups\<name>.zip
```

恢复后必须重建索引并验证来源清单。

## 清理

缓存和派生索引可以删除后重建。`bank/sources/`、`bank/items/`、正式输出和备份只能由用户明确删除。
