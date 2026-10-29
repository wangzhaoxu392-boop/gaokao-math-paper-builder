# 题目与来源数据规则

## 唯一事实

- `bank/sources/<source-id>/manifest.json` 保存原始来源与提取文本状态。
- `bank/packets/<packet-id>/manifest.json` 保存题卷、答案和解析之间的多对多关系。
- `bank/items/L*/<item-id>.json` 是题目的唯一主记录。
- `bank/index.csv`、缓存和向量是可重建派生数据。
- 已导出的试卷放在 `outputs/`，不能由普通题库操作静默覆盖。

## 题目必填字段

使用 `scripts/item.schema.json`。至少需要：

- `id`、`schema_version`、`created_at`、`updated_at`
- `stem_markdown`、`question_type`、`topic_codes`
- `primary_band`、`support_bands`、`difficulty_evidence`
- `answer`、`solution`、`answer_provenance`、`answer_status`
- `grade`、`paper_type`、`new_gaokao_alignment`
- `source_authority`、`review_status`、`validity_status`
- `split_confidence`、`split_status`、`source_location`

## 关联和版本

- 子问使用 `parent_item_id` 和 `depends_on` 保留关系。
- 改编题记录 `adaptation_of` 和 `source_item_ids`。
- 同一模板归属 `variant_family`。
- 来源、课程规范、蓝图、提示词和输出模板都有版本号。
- 任何内容变化都更新 `content_hash` 和 `updated_at`。
- 自动拆题的媒体使用来源目录内相对路径，不复制到题目目录。

- 拆题记录保存 `split_rule_version`、`source_segment`、`container_item` 和 `exclusion_code`。
- 逻辑删除使用 `review_status=deprecated`、`validity_status=deprecated` 和固定 `exclusion_code`，原始来源与旧题干不得清除。

## 审核状态

`draft` -> `needs_review` -> `verified` 是正常路径；`deprecated` 用于保留历史但停止使用。正式选题默认只接受 `verified`。

## 学生信息

题库不保存学生姓名。生成任务可以使用匿名 `student_ref`，仅保存当前档位、目标档位和薄弱专题。日志和文档属性不得包含个人信息。
