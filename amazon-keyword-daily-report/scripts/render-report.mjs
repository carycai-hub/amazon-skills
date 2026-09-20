#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProductImage } from "./product-image.mjs";

const SENSITIVE_KEYS = /(?:token|secret|password|authorization|cookie|app[_-]?key|webhook)/i;
const EDITIONS = new Set(["auto", "basic", "enhanced"]);

function parseArgs(argv) {
  const args = { screenshot: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") {
      process.stdout.write("Usage: node scripts/render-report.mjs --input <report-data.json> --output-dir <directory> [--no-screenshot]\n");
      process.exit(0);
    }
    else if (value === "--input") args.input = argv[++index];
    else if (value === "--output-dir") args.outputDir = argv[++index];
    else if (value === "--no-screenshot") args.screenshot = false;
    else throw new Error(`unknown_argument:${value}`);
  }
  if (!args.input) throw new Error("missing_argument:--input");
  if (!args.outputDir) throw new Error("missing_argument:--output-dir");
  return args;
}

function findSensitiveKey(value, path = "root") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) return `${path}.${key}`;
    const nested = findSensitiveKey(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function validateRank(value, path) {
  if (value === null) return;
  if (!value || typeof value !== "object") throw new Error(`invalid_rank:${path}`);
  if (!Number.isInteger(value.rank) || value.rank < 1) throw new Error(`invalid_rank:${path}.rank`);
  if (value.page !== null && (!Number.isInteger(value.page) || value.page < 1)) {
    throw new Error(`invalid_rank:${path}.page`);
  }
}

function validateInput(data) {
  const sensitivePath = findSensitiveKey(data);
  if (sensitivePath) throw new Error(`sensitive_field_rejected:${sensitivePath}`);
  if (typeof data.asin !== "string" || !/^[A-Z0-9]{10}$/.test(data.asin)) throw new Error("invalid_asin");
  if (typeof data.marketplace !== "string" || !/^[A-Z]{2,3}$/.test(data.marketplace)) throw new Error("invalid_marketplace");
  if (!isIsoDate(data.reportDate) || !isIsoDate(data.comparisonDate)) throw new Error("invalid_report_dates");
  if (!Array.isArray(data.keywords) || data.keywords.length < 1 || data.keywords.length > 30) throw new Error("invalid_keywords");
  if (data.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim())) throw new Error("invalid_keyword_value");
  if (new Set(data.keywords).size !== data.keywords.length) throw new Error("duplicate_keywords");
  if (!Array.isArray(data.samplingTimes) || data.samplingTimes.length < 1 || data.samplingTimes.length > 8 || data.samplingTimes.some((time) => !isTime(time))) throw new Error("invalid_sampling_times");
  if (new Set(data.samplingTimes).size !== data.samplingTimes.length) throw new Error("duplicate_sampling_times");
  if (!EDITIONS.has(data.requestedEdition ?? "auto")) throw new Error("invalid_report_edition");
  if (!Array.isArray(data.rows) || data.rows.length !== data.keywords.length) throw new Error("invalid_rows");

  for (let rowIndex = 0; rowIndex < data.rows.length; rowIndex += 1) {
    const row = data.rows[rowIndex];
    if (row.keyword !== data.keywords[rowIndex]) throw new Error(`keyword_order_mismatch:${rowIndex}`);
    if (!Array.isArray(row.samples) || row.samples.length !== data.samplingTimes.length) throw new Error(`invalid_samples:${row.keyword}`);
    row.samples.forEach((sample, sampleIndex) => {
      if (sample.time !== data.samplingTimes[sampleIndex]) throw new Error(`sample_time_mismatch:${row.keyword}:${sampleIndex}`);
      if (typeof sample.observedPrevious !== "boolean" || typeof sample.observedCurrent !== "boolean") throw new Error(`missing_sample_status:${row.keyword}:${sample.time}`);
      if (!sample.observedPrevious || !sample.observedCurrent) throw new Error(`basic_data_gap:${row.keyword}:${sample.time}`);
      validateRank(sample.organic?.previous ?? null, `${row.keyword}.${sample.time}.organic.previous`);
      validateRank(sample.organic?.current ?? null, `${row.keyword}.${sample.time}.organic.current`);
      validateRank(sample.ad?.previous ?? null, `${row.keyword}.${sample.time}.ad.previous`);
      validateRank(sample.ad?.current ?? null, `${row.keyword}.${sample.time}.ad.current`);
    });
  }

  const basicSource = data.sources?.find((source) => source.sourceId === "rank_hourly" && source.status === "success");
  if (!basicSource?.readAt || !basicSource?.scope) throw new Error("missing_basic_source_trace");
}

function hasMetric(metric) {
  return metric && typeof metric.previous === "number" && typeof metric.current === "number";
}

function decideEdition(data) {
  const requested = data.requestedEdition ?? "auto";
  if (requested === "basic") return { label: "基础版报告", reason: "用户显式选择 basic，未消费 SIF 增强来源。" };
  const hasEnhancementInput = Boolean(data.sif || data.monitorCandidates?.length);
  if (hasEnhancementInput && data.enhancementScopeMatch !== true) {
    if (requested === "enhanced") throw new Error("enhanced_report_blocked:scope_mismatch");
    return { label: "基础版报告", reason: "SIF 增强来源与基础排名的 ASIN、站点或周期口径不一致。" };
  }
  const trafficComplete = Boolean(
    data.enhancementScopeMatch === true && data.sif?.scopeMatch &&
    isIsoDate(data.sif.latestDate) &&
    hasMetric(data.sif.total) &&
    hasMetric(data.sif.natural) &&
    hasMetric(data.sif.ad) &&
    hasMetric(data.sif.sp),
  );
  const keywordsComplete = Array.isArray(data.monitorCandidates) && data.monitorCandidates.some((keyword) => typeof keyword === "string" && keyword.trim());
  if (!trafficComplete && !keywordsComplete) {
    if (requested === "enhanced") throw new Error("enhanced_report_blocked:missing_enhancement_modules");
    return { label: "基础版报告", reason: "SIF 增强模块未形成有效闭合数据，保留基础排名报告。" };
  }
  if (trafficComplete && keywordsComplete) return { label: "增强版报告（完整增强）", reason: "SIF 流量趋势与候选词模块均完整。" };
  return { label: "增强版报告（部分增强）", reason: trafficComplete ? "SIF 流量趋势完整，候选词模块缺失。" : "SIF 候选词模块可用，流量趋势模块缺失。" };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatRank(value) {
  return value ? `P${value.page ?? "?"}-${value.rank}` : "—";
}

function change(previous, current) {
  if (!previous && !current) return "均未出现";
  if (!previous) return "新增";
  if (!current) return "消失";
  const delta = current.rank - previous.rank;
  if (delta === 0) return "持平";
  return `${delta < 0 ? "↑" : "↓"}${Math.abs(delta)}`;
}

function changeClass(value) {
  if (value.startsWith("↑") || value === "新增") return "up";
  if (value.startsWith("↓") || value === "消失") return "down";
  return "neutral";
}

function rankLine(label, pair) {
  const delta = change(pair?.previous ?? null, pair?.current ?? null);
  const type = label === "自然" ? "organic" : "ad";
  return `<div class="rank-line"><span class="rank-label ${type}">${label}</span><span class="rank-route"><span class="rank-day">昨</span><b class="rank-value">${formatRank(pair?.previous ?? null)}</b><i>→</i><span class="rank-day">今</span><b class="rank-value current">${formatRank(pair?.current ?? null)}</b></span><span class="delta-pill ${changeClass(delta)}">${delta}</span></div>`;
}

function percent(metric) {
  if (!hasMetric(metric) || metric.previous === 0) return "暂无";
  const value = (metric.current - metric.previous) / metric.previous;
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function transition(metric) {
  if (!hasMetric(metric)) return "—";
  const number = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${number(metric.previous)}→${number(metric.current)}`;
}

function summarize(values) {
  const counts = {
    up: values.filter((value) => value.startsWith("↑")).length,
    down: values.filter((value) => value.startsWith("↓")).length,
    same: values.filter((value) => value === "持平").length,
    added: values.filter((value) => value === "新增").length,
    lost: values.filter((value) => value === "消失").length,
    empty: values.filter((value) => value === "均未出现").length,
  };
  return [counts.up && `${counts.up} 个上升`, counts.down && `${counts.down} 个下降`, counts.same && `${counts.same} 个持平`, counts.added && `${counts.added} 个新增`, counts.lost && `${counts.lost} 个消失`, counts.empty && `${counts.empty} 个均未出现`].filter(Boolean).join("，") || "无可比变化";
}

function sourceRows(sources) {
  return (sources ?? []).map((source) => `<tr><td>${escapeHtml(source.sourceId)}</td><td>${escapeHtml(source.role)}</td><td>${escapeHtml(source.status)}</td><td>${escapeHtml(source.tool)}</td><td>${escapeHtml(source.readAt)}</td><td>${escapeHtml(source.scope)}</td></tr>`).join("");
}

function buildHtml(data, edition, productImage) {
  const organicChanges = data.rows.flatMap((row) => row.samples.map((sample) => change(sample.organic?.previous ?? null, sample.organic?.current ?? null)));
  const adChanges = data.rows.flatMap((row) => row.samples.map((sample) => change(sample.ad?.previous ?? null, sample.ad?.current ?? null)));
  const rankRows = data.rows.map((row) => `<tr><td class="keyword">${escapeHtml(row.keyword)}</td>${row.samples.map((sample) => `<td>${rankLine("自然", sample.organic)}${rankLine("广告", sample.ad)}</td>`).join("")}</tr>`).join("");
  const sifCards = data.sif?.scopeMatch ? [
    ["总流量", percent(data.sif.total)],
    ["自然流量", percent(data.sif.natural)],
    ["广告流量", percent(data.sif.ad)],
    ["SP 流量", percent(data.sif.sp)],
    ["主类 BSR", transition(data.sif.mainBsr)],
    ["子类 BSR", transition(data.sif.subBsr)],
    ["价格", data.sif.buyboxPrice == null ? "—" : `$${Number(data.sif.buyboxPrice).toFixed(2)}`],
    ["Prime 价", data.sif.primePrice == null ? "—" : `$${Number(data.sif.primePrice).toFixed(2)}`],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("") : "";
  const actions = (data.analysis?.actions ?? ["复核核心词的排名和广告连续性。"]).map((action, index) => `<li><b>${index + 1}</b><span>${escapeHtml(action)}</span></li>`).join("");
  const limitations = (data.analysis?.limitations ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const candidates = (data.monitorCandidates ?? []).map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join("");
  const renderFooter = data.sif?.renderFooter ? `<div class="sif-footer">${escapeHtml(data.sif.renderFooter)}</div>` : "";
  const styles = readFileSync(new URL("../assets/report.css", import.meta.url), "utf8");
  const pageWidth = Math.max(1516, 430 + data.samplingTimes.length * 230);
  const imageMarkup = productImage.dataUrl
    ? `<img src="${escapeHtml(productImage.dataUrl)}" alt="${escapeHtml(data.asin)} 产品主图">`
    : '<span class="image-placeholder">主图暂缺</span>';
  const sifSection = sifCards
    ? `<section class="section"><div class="section-title">SIF 经营基线</div><div class="metrics">${sifCards}</div><div class="foot">最新闭合日 ${escapeHtml(data.sif.latestDate)} vs ${escapeHtml(data.sif.previousDate ?? "—")}；SIF 用于经营趋势判断，不与西柚绝对排名混用。</div></section>`
    : '<section class="section"><div class="section-title">SIF 经营基线</div><div class="diagnosis">本次未形成有效 SIF 增强模块，报告已按基础版输出。</div></section>';
  const candidateSection = candidates ? `<section class="section"><div class="section-title">候选观察词</div><div class="tags">${candidates}</div></section>` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.asin)} 关键词排名日报</title><style>${styles}</style></head>
<body><main class="page" style="width:${pageWidth}px">
  <header class="report-hero">
    <div class="product-image">${imageMarkup}</div>
    <div class="hero-copy">
      <div class="eyebrow">AMAZON / ${escapeHtml(data.marketplace)} · DAILY INTELLIGENCE</div>
      <h1>${escapeHtml(data.asin)} 关键词排名日报</h1>
      <div class="subtitle">${escapeHtml(data.timezone)} · ${escapeHtml(data.reportDate)} 当天 vs ${escapeHtml(data.comparisonDate)} 昨天</div>
      <div class="hero-badges"><span>${escapeHtml(edition.label)}</span><span>数据质量 ${escapeHtml(data.dataQuality ?? "B")}</span><span>证据等级 ${escapeHtml(data.evidenceLevel ?? "中")}</span></div>
    </div>
  </header>
  <div class="summary">
    <div class="summary-card organic-summary"><small>自然位变化</small><b>${summarize(organicChanges)}</b></div>
    <div class="summary-card ad-summary"><small>广告位变化</small><b>${summarize(adChanges)}</b></div>
    <div class="summary-card sample-summary"><small>采样规模</small><b>${data.keywords.length} 个词 · ${data.samplingTimes.length} 个时点</b></div>
  </div>
  <div class="edition-note"><span>版本说明</span><b>${escapeHtml(edition.reason)}</b></div>
  <div class="table-wrap"><table class="rank-table"><colgroup><col class="keyword-col">${data.samplingTimes.map(() => "<col>").join("")}</colgroup><thead><tr><th>关键词</th>${data.samplingTimes.map((time) => `<th>${escapeHtml(time)}</th>`).join("")}</tr></thead><tbody>${rankRows}</tbody></table></div>
  <div class="legend">格式：P2-13 = 第 2 页第 13 名；每格为“前一日 → 当天”同一时点对比；排名数字越小越好。自然位与广告位口径不混用。</div>
  ${sifSection}
  <div class="decision-grid">
    <section class="section diagnosis-section"><div class="section-title">关键词排名变化原因</div><div class="diagnosis">${escapeHtml(data.analysis?.diagnosis ?? "仅基于同一时点自然位和广告位变化判断，未形成进一步归因。")}</div>${limitations ? `<ul class="limitations">${limitations}</ul>` : ""}</section>
    <section class="section action-section"><div class="section-title">今日工作安排</div><ol class="actions">${actions}</ol><div class="warning"><b>暂不建议：</b>仅基于未闭合日小时数据直接判断 ACoS / CVR、全局扩预算、批量否词或大改 Listing。</div></section>
  </div>
  ${candidateSection}
  <section class="section evidence-section"><div class="section-title">数据来源</div><table class="source-table"><thead><tr><th>来源</th><th>角色</th><th>状态</th><th>工具</th><th>读取时间</th><th>口径</th></tr></thead><tbody>${sourceRows(data.sources)}</tbody></table>${renderFooter}</section>
  <div class="foot">生成时间：${escapeHtml(data.generatedAt ?? "未提供")}｜HTML 与截图由同一份标准化数据生成</div>
</main></body></html>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function renderScreenshot(htmlPath, pngPath, rowCount, sampleCount) {
  const chrome = findChrome();
  if (!chrome) throw new Error("screenshot_renderer_unavailable:set_CHROME_BIN_or_use_browser_tool");
  const profileDir = resolve(tmpdir(), `keyword-report-chrome-${process.pid}`);
  const width = Math.max(1600, 514 + sampleCount * 230);
  const height = Math.min(10000, Math.max(1700, 1450 + rowCount * 110));
  rmSync(pngPath, { force: true });
  const result = spawnSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--no-default-browser-check",
    "--no-first-run",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ], { encoding: "utf8", timeout: 12_000, killSignal: "SIGKILL" });
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Chrome may briefly retain its isolated profile after the screenshot is complete.
  }
  if (!existsSync(pngPath)) throw new Error(`screenshot_failed:${result.status ?? result.signal ?? "unknown"}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const outputDir = resolve(args.outputDir);
  const data = JSON.parse(readFileSync(inputPath, "utf8"));
  validateInput(data);
  const edition = decideEdition(data);
  const productImage = await resolveProductImage(data);
  mkdirSync(outputDir, { recursive: true });
  const htmlPath = resolve(outputDir, "keyword-daily-report.html");
  const pngPath = resolve(outputDir, "keyword-daily-report.png");
  writeFileSync(htmlPath, buildHtml(data, edition, productImage), "utf8");
  if (args.screenshot) renderScreenshot(htmlPath, pngPath, data.rows.length, data.samplingTimes.length);
  process.stdout.write(JSON.stringify({
    ok: true,
    edition: edition.label,
    productImageStatus: productImage.status,
    input: basename(inputPath),
    htmlPath,
    pngPath: args.screenshot ? pngPath : null,
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
