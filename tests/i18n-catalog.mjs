import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import zhCN from "../i18n/zh-CN.js";
import enUS from "../i18n/en-US.js";

function catalogKeys(catalog) {
  return Object.keys(catalog).sort();
}

function extractInterpolationParams(template) {
  const params = new Set();
  const re = /\{\{?\s*([A-Za-z_][\w.-]*)\s*\}?\}/g;
  let match;
  while ((match = re.exec(String(template)))) {
    params.add(match[1]);
  }
  return [...params].sort();
}

const zhKeys = catalogKeys(zhCN);
const enKeys = catalogKeys(enUS);
const onlyZh = zhKeys.filter((key) => !Object.prototype.hasOwnProperty.call(enUS, key));
const onlyEn = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(zhCN, key));

assert.deepEqual(onlyZh, [], `keys in zh-CN but missing in en-US: ${onlyZh.join(", ")}`);
assert.deepEqual(onlyEn, [], `keys in en-US but missing in zh-CN: ${onlyEn.join(", ")}`);
assert.equal(zhKeys.length, enKeys.length, "zh-CN and en-US catalog key counts differ");

for (const key of zhKeys) {
  assert.equal(typeof zhCN[key], "string", `zh-CN ${key} must be a string`);
  assert.equal(typeof enUS[key], "string", `en-US ${key} must be a string`);
  assert.ok(zhCN[key].trim(), `zh-CN ${key} must not be empty`);
  assert.ok(enUS[key].trim(), `en-US ${key} must not be empty`);
  assert.deepEqual(
    extractInterpolationParams(zhCN[key]),
    extractInterpolationParams(enUS[key]),
    `interpolation params differ for ${key}`,
  );
}

assert.ok(zhKeys.length >= 60, "Phase 0 catalog should include a meaningful seed set");
assert.ok(
  zhKeys.some((key) => extractInterpolationParams(zhCN[key]).length > 0),
  "catalog should include at least one interpolated string",
);

const panelHtml = readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
const htmlKeys = new Set();
const attrRe = /data-i18n(?:-[a-z-]+)?="([^"]+)"/g;
let match;
while ((match = attrRe.exec(panelHtml))) {
  htmlKeys.add(match[1]);
}
assert.ok(htmlKeys.size > 0, "panel.html should contain data-i18n references after Phase 1");
const missingHtmlKeys = [...htmlKeys].filter((key) => !Object.prototype.hasOwnProperty.call(zhCN, key));
assert.deepEqual(
  missingHtmlKeys,
  [],
  `panel.html references missing i18n keys: ${missingHtmlKeys.join(", ")}`,
);

console.log("i18n catalog tests passed");
