import assert from "node:assert/strict";

const {
  isLikelyMvuWorldInfoContent,
  isMvuTaggedWorldInfoNameOrComment,
  sanitizeMvuContent,
} = await import("../prompting/mvu-compat.js");

assert.equal(
  isMvuTaggedWorldInfoNameOrComment("[mvu_update] 状态", ""),
  true,
);
assert.equal(
  isMvuTaggedWorldInfoNameOrComment("普通条目", "[initvar]"),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    "变量更新规则:\ntype: state\n当前时间: 12:00",
  ),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    '{"stat_data":{"地点":"学校"},"display_data":{"地点":"教室"}}',
  ),
  true,
);
assert.equal(isLikelyMvuWorldInfoContent("正常世界设定"), false);

const aggressive = sanitizeMvuContent(
  "正文\n<updatevariable>hp=1</updatevariable>\n<status_current_variable>secret</status_current_variable>",
  {
    mode: "aggressive",
  },
);
assert.equal(aggressive.text, "");
assert.equal(aggressive.dropped, true);
assert.deepEqual(
  aggressive.reasons.sort(),
  ["artifact_stripped", "likely_mvu_content"].sort(),
);

const finalSafe = sanitizeMvuContent(
  "说明文字\n<updatevariable>hp=1</updatevariable>\n尾巴",
  {
    mode: "final-safe",
  },
);
assert.equal(finalSafe.dropped, false);
assert.equal(finalSafe.text, "说明文字\n尾巴");
assert.deepEqual(finalSafe.reasons, ["artifact_stripped"]);

const macroSafe = sanitizeMvuContent(
  "地点={{get_message_variable::stat_data.地点}}\n<%- SafeGetValue(msg_data.地点) %>",
  {
    mode: "final-safe",
  },
);
assert.equal(macroSafe.dropped, false);
assert.equal(macroSafe.text, "地点=");
assert.deepEqual(macroSafe.reasons, ["artifact_stripped"]);

const blocked = sanitizeMvuContent("前缀\n被拦截条目\n后缀", {
  mode: "final-safe",
  blockedContents: ["被拦截条目"],
});
assert.equal(blocked.text, "前缀\n\n后缀");
assert.equal(blocked.blockedHitCount, 1);
assert.deepEqual(blocked.reasons, ["blocked_content_removed"]);

console.log("mvu-compat tests passed");
