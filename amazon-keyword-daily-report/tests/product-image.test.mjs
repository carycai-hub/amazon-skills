import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductImage } from "../scripts/product-image.mjs";

const report = { asin: "B0GCZFMWFM", marketplace: "US" };
const image = {
  asin: "B0GCZFMWFM",
  marketplace: "US",
  url: "https://m.media-amazon.com/images/I/example._AC_US600_.jpg",
};

test("缺少产品主图时保留占位", async () => {
  const result = await resolveProductImage(report, () => { throw new Error("should not fetch"); });
  assert.equal(result.status, "missing");
  assert.equal(result.dataUrl, null);
});

test("ASIN 或站点错配时不请求图片", async () => {
  for (const field of ["asin", "marketplace"]) {
    const result = await resolveProductImage({ ...report, productImage: { ...image, [field]: "WRONG" } }, () => { throw new Error("should not fetch"); });
    assert.equal(result.status, "identity_mismatch");
  }
});

test("拒绝非 Amazon 图片地址和附带参数的地址", async () => {
  for (const url of [
    "https://example.com/images/I/test.jpg",
    "http://m.media-amazon.com/images/I/test.jpg",
    "https://m.media-amazon.com.evil.test/images/I/test.jpg",
    "https://m.media-amazon.com/images/I/test.jpg?token=secret",
  ]) {
    const result = await resolveProductImage({ ...report, productImage: { ...image, url } }, () => { throw new Error("should not fetch"); });
    assert.equal(result.status, "invalid_url");
  }
});

test("已核对的图片内嵌为 data URL", async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = await resolveProductImage({ ...report, productImage: image }, async (url, options) => {
    assert.equal(url, image.url);
    assert.equal(options.redirect, "error");
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  });
  assert.equal(result.status, "available");
  assert.equal(result.dataUrl, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
});

test("下载失败或类型错误时不阻断报告", async () => {
  const failed = await resolveProductImage({ ...report, productImage: image }, async () => { throw new Error("offline"); });
  const wrongType = await resolveProductImage({ ...report, productImage: image }, async () => new Response("html", { headers: { "content-type": "text/html" } }));
  assert.equal(failed.status, "fetch_failed");
  assert.equal(wrongType.status, "invalid_image");
  assert.equal(failed.dataUrl, null);
  assert.equal(wrongType.dataUrl, null);
});
