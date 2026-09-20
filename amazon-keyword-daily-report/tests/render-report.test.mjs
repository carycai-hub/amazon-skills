import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(skillDir, "scripts/render-report.mjs");
const fixturePath = resolve(skillDir, "tests/fixture-full.json");

function runFixture(data) {
  const tempDir = mkdtempSync(resolve(tmpdir(), "keyword-report-test-"));
  const input = resolve(tempDir, "input.json");
  writeFileSync(input, JSON.stringify(data), "utf8");
  execFileSync(process.execPath, [script, "--input", input, "--output-dir", tempDir, "--no-screenshot"]);
  return readFileSync(resolve(tempDir, "keyword-daily-report.html"), "utf8");
}

test("完整增强输入生成 HTML 并保留排名和版本标签", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  const html = runFixture(data);
  assert.match(html, /增强版报告（完整增强）/);
  assert.match(html, /P1-24/);
  assert.match(html, /elevated toilet seat/);
  assert.match(html, /主图暂缺/);
  assert.match(html, /class="report-hero"/);
  assert.match(html, /class="summary-card organic-summary"/);
  assert.match(html, /class="summary-card ad-summary"/);
  assert.match(html, /class="delta-pill up"/);
  assert.match(html, /class="decision-grid"/);
  assert.match(html, /class="section evidence-section"/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<link\b/i);
});

test("缺少 SIF 时 auto 降级为基础版", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.sif = null;
  data.monitorCandidates = [];
  data.sources = data.sources.filter((source) => source.role === "basic");
  const html = runFixture(data);
  assert.match(html, /基础版报告/);
  assert.doesNotMatch(html, /增强版报告（完整增强）/);
});

test("只缺展示字段仍保持完整增强", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.sif.buyboxPrice = null;
  data.sif.primePrice = null;
  data.sif.review = null;
  data.sif.star = null;
  const html = runFixture(data);
  assert.match(html, /增强版报告（完整增强）/);
});

test("凭证字段在任何模式下都阻断且不回显值", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.webhook = "should-never-appear";
  const tempDir = mkdtempSync(resolve(tmpdir(), "keyword-report-test-"));
  const input = resolve(tempDir, "input.json");
  writeFileSync(input, JSON.stringify(data), "utf8");
  const result = spawnSync(process.execPath, [script, "--input", input, "--output-dir", tempDir, "--no-screenshot"], {encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sensitive_field_rejected/);
  assert.doesNotMatch(result.stderr, /should-never-appear/);
});

test("只有流量模块时生成部分增强版", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.monitorCandidates = [];
  const html = runFixture(data);
  assert.match(html, /增强版报告（部分增强）/);
});

test("显式 enhanced 且增强模块缺失时阻断", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.requestedEdition = "enhanced";
  data.sif = null;
  data.monitorCandidates = [];
  const tempDir = mkdtempSync(resolve(tmpdir(), "keyword-report-test-"));
  const input = resolve(tempDir, "input.json");
  writeFileSync(input, JSON.stringify(data), "utf8");
  const result = spawnSync(process.execPath, [script, "--input", input, "--output-dir", tempDir, "--no-screenshot"], {encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enhanced_report_blocked/);
});

test("SIF 口径冲突时 auto 保留基础版", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.enhancementScopeMatch = false;
  const html = runFixture(data);
  assert.match(html, /基础版报告/);
  assert.match(html, /口径不一致/);
});

test("任一请求时点未返回时阻断基础报告", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.rows[0].samples[0].observedCurrent = false;
  const tempDir = mkdtempSync(resolve(tmpdir(), "keyword-report-test-"));
  const input = resolve(tempDir, "input.json");
  writeFileSync(input, JSON.stringify(data), "utf8");
  const result = spawnSync(process.execPath, [script, "--input", input, "--output-dir", tempDir, "--no-screenshot"], {encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /basic_data_gap/);
});

test("主图错配时仍输出横向报告，且不写入图片地址", () => {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  data.productImage = {
    asin: "B000000000",
    marketplace: "US",
    url: "https://m.media-amazon.com/images/I/wrong.jpg",
  };
  const html = runFixture(data);
  assert.match(html, /主图暂缺/);
  assert.match(html, /class="report-hero"/);
  assert.doesNotMatch(html, /wrong\.jpg/);
  assert.match(html, /关键词排名变化原因/);
});
