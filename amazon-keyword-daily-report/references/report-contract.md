# 报告契约

## 数据来源表

| source_id | 角色 | 类型 | 提供方与入口 | 粒度 | 口径 | 时效 | 主来源与降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `rank_hourly` | basic | third_party | 西柚 `get_asin_keyword_rank_hourly` | ASIN × 关键词 × 小时 | 请求站点当地时间；自然位 `or`、广告位 `sp` | 运行时读取 | 主来源；仅可降级到提供完全相同语义的小时排名文件或工具 |
| `sif_traffic` | enhancement | third_party | `sif-v2` `sifv2_asinOpTrafficTrend` | ASIN × 日 | 最新闭合日；总/自然/广告/SP、BSR 等 | 最新闭合日 | 失败时跳过流量增强，不替代基础排名 |
| `sif_keywords` | enhancement | third_party | `sif-v2` `sifv2_asinKeywordsSimpleGroupByWeekly` | ASIN × 周 × 关键词 | 最近闭合周；用于候选词，不等同小时排名 | 最新闭合周 | 失败时跳过拓词模块 |
| `asin_detail` | display_optional | third_party | 西柚 `getAsinDetail` | ASIN × 站点 | 核对返回 ASIN 与站点，只取对应主图 | 运行时读取 | 缺失、错配或下载失败时显示“主图暂缺” |
| `manual_rank_file` | basic fallback | manual | 用户提供 JSON/CSV | 同 `rank_hourly` | 必须含站点、日期、小时、排名类型和读取来源 | 用户提供时 | 仅在西柚不可用且口径完整时使用 |

来源追溯只记录工具名、状态、读取时间和口径，不记录凭证、完整授权 URL 或内部身份标识。

## 指标字典

| metric_id | 名称 | 定义或公式 | 单位/粒度 | source_id | 字段等级 | 缺失行为 | 决策依赖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `organic_rank` | 自然位 | `displayPosition=or` 的 `totalRank`；页码单独保存 | 名次 / 关键词×小时 | `rank_hourly` | `basic_required` | BLOCK；查询成功但无排名可为 null | 排名表、变化摘要 |
| `ad_rank` | 广告位 | `displayPosition=sp` 的 `totalRank`；页码单独保存 | 名次 / 关键词×小时 | `rank_hourly` | `basic_required` | BLOCK；查询成功但无排名可为 null | 排名表、广告连续性 |
| `sample_status` | 采样状态 | 指定关键词、日期和时点是否成功返回 | 布尔 / 关键词×小时 | `rank_hourly` | `basic_required` | BLOCK | 区分“无排名”和“未查询” |
| `scope_match` | 增强口径匹配 | ASIN、站点、日期、粒度与读取时间全部匹配 | 布尔 | 所有增强源 | `enhancement_global_required` | BASIC 或显式 enhanced BLOCK | 是否允许合并 SIF |
| `total_change` | 总流量变化 | `(当前-前值)/前值` | % / 日 | `sif_traffic` | `module_required` + `full_required` | SKIP | 流量判断 |
| `natural_change` | 自然流量变化 | 同上 | % / 日 | `sif_traffic` | `module_required` + `full_required` | SKIP | 自然流量判断 |
| `ad_change` | 广告流量变化 | 同上 | % / 日 | `sif_traffic` | `module_required` + `full_required` | SKIP | 广告流量判断 |
| `sp_change` | SP 流量变化 | 同上 | % / 日 | `sif_traffic` | `module_required` + `full_required` | SKIP | SP 判断 |
| `monitor_candidates` | 候选观察词 | 最近闭合周高分且未跟踪的相关词 | 关键词列表 / 周 | `sif_keywords` | `module_required` + `full_required` | SKIP | 拓词动作 |
| `main_bsr` | 主类 BSR | 最新闭合日值与前值 | 名次 / 日 | `sif_traffic` | `display_optional` | 显示 — | 佐证经营趋势 |
| `sub_bsr` | 子类 BSR | 最新闭合日值与前值 | 名次 / 日 | `sif_traffic` | `display_optional` | 显示 — | 佐证类目趋势 |
| `price` | 价格 | Buy Box 与 Prime 价 | USD / 日 | `sif_traffic` | `display_optional` | 显示 — | 价格背景 |
| `review_star` | 评论与星级 | 评论数变化和当前星级 | 数量/星级 / 日 | `sif_traffic` | `display_optional` | 显示 — | 转化背景 |
| `product_image` | ASIN 产品主图 | 西柚详情返回的同 ASIN、同站点图片 | 图片 / ASIN | `asin_detail` | `display_optional` | 显示“主图暂缺” | 报告识别，不参与排名或版本判定 |

## 报告版本路由

默认 `report_edition=auto`，顺序不可交换：

1. ASIN、关键词、时点、日期或任一基础查询状态无效：阻断并列出基础数据缺口。
2. 显式 `basic`：只生成基础版，不调用 SIF。
3. 发现凭证字段、站点回落、损坏数据或语义冲突：所有模式阻断且不回显敏感值。
4. SIF 口径匹配失败或两个增强模块均未完成：`auto` 生成“基础版报告”并解释原因；显式 `enhanced` 阻断。
5. 仅流量趋势或仅候选词模块完成：生成“增强版报告（部分增强）”，缺失模块标 `SKIP/MANUAL`。
6. 流量趋势和候选词两个完整增强模块均完成：生成“增强版报告（完整增强）”。
7. 只缺价格、Prime 价、评论、星级或子类名称等 `display_optional` 字段，不影响完整增强标签。

## 动作门槛

- 只有小时排名：可给观察和复核动作，证据最高为“中”。
- 有闭合日 SIF 流量：可判断流量结构变化，但不得替代 Seller Central 的订单、ACoS 或 CVR。
- 小时排名与 SIF 冲突：并列呈现，标记口径差异，不求平均。
- 未闭合美国当天：禁止据此做全局预算、批量否词或大改 Listing 的确定性建议。
