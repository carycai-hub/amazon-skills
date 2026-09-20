# 渲染输入结构

`scripts/render-report.mjs` 接收一个 UTF-8 JSON 文件。不得把 Token、Secret、Cookie、认证头、App Key 或 Webhook 写入该文件。

## 最小结构

```json
{
  "asin": "B0GCZFMWFM",
  "marketplace": "US",
  "timezone": "America/Los_Angeles",
  "reportDate": "2026-09-08",
  "comparisonDate": "2026-09-07",
  "samplingTimes": ["08:00", "12:00", "14:00", "17:00"],
  "requestedEdition": "auto",
  "enhancementScopeMatch": true,
  "dataQuality": "A",
  "evidenceLevel": "中",
  "keywords": ["raised toilet seat"],
  "rows": [
    {
      "keyword": "raised toilet seat",
      "samples": [
        {
          "time": "08:00",
          "observedPrevious": true,
          "observedCurrent": true,
          "organic": {
            "previous": {"page": 1, "rank": 24},
            "current": {"page": 1, "rank": 21}
          },
          "ad": {
            "previous": {"page": 1, "rank": 4},
            "current": {"page": 1, "rank": 3}
          }
        }
      ]
    }
  ],
  "sources": [
    {
      "sourceId": "rank_hourly",
      "role": "basic",
      "status": "success",
      "tool": "get_asin_keyword_rank_hourly",
      "readAt": "2026-09-09T01:25:00Z",
      "scope": "US | ASIN | keyword | local hour"
    }
  ],
  "productImage": null,
  "sif": null,
  "monitorCandidates": [],
  "analysis": {
    "diagnosis": "仅基于同一时点排名变化判断。",
    "actions": ["午间复核广告位连续性。"],
    "limitations": ["美国当天尚未结束。"]
  },
  "generatedAt": "2026-09-09 09:25"
}
```

## 排名字段

- 成功查询但目标位置未出现：`previous` 或 `current` 写 `null`，相应 `observedPrevious/observedCurrent` 仍为 `true`。
- 工具没有返回请求时点：相应 `observed...` 为 `false`，属于基础数据缺口；除非用户允许时间容差，否则阻断完整报告。
- `rank` 和 `page` 必须是正整数。页面数据缺失时 `page` 可为 `null`，HTML 显示 `P?-名次` 并标记展示字段缺失。

## SIF 增强字段

```json
{
  "latestDate": "2026-09-07",
  "previousDate": "2026-09-06",
  "scopeMatch": true,
  "total": {"previous": 100, "current": 110},
  "natural": {"previous": 60, "current": 62},
  "ad": {"previous": 40, "current": 48},
  "sp": {"previous": 25, "current": 31},
  "mainBsr": {"previous": 32000, "current": 30000},
  "subBsr": {"previous": 18, "current": 17},
  "buyboxPrice": 94.99,
  "primePrice": 59.99,
  "review": {"previous": 159, "current": 160},
  "star": 4.3,
  "renderFooter": null
}
```

变化率由渲染脚本计算，不要预先手算。`monitorCandidates` 至少一个非空关键词时，候选词增强模块才算完成。

`enhancementScopeMatch` 只有在 SIF 的 ASIN、站点、周期、时间粒度和来源追溯均与报告一致时才能为 `true`。若为 `false`，`auto` 必须退回基础版，显式 `enhanced` 必须阻断。

## ASIN 主图（可选展示字段）

按 ASIN 查询西柚 `getAsinDetail`，只有返回的 `asin` 与 `marketplace` 均和报告完全一致时，才填入：

```json
"productImage": {
  "asin": "B0GCZFMWFM",
  "marketplace": "US",
  "url": "https://m.media-amazon.com/images/I/example.jpg",
  "sourceId": "asin_detail"
}
```

`url` 优先取 `zoomImageUrl`，其次取 `imageUrl`；示例地址仅说明格式，不是可用图片。`sources` 同时记录 `asin_detail` 的工具名、读取时间、站点和 ASIN 口径，角色为 `display_optional`。图片缺失或下载失败时 `productImage` 可为 `null`；渲染器显示“主图暂缺”，不影响日报版本或排名计算。渲染器只接受 HTTPS `m.media-amazon.com/images/` 地址，并把成功读取的图片内嵌进 HTML，截图不另取图。
