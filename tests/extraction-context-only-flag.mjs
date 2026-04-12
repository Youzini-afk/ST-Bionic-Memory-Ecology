import assert from "node:assert/strict";
import {
  buildExtractionMessages,
} from "../maintenance/chat-history.js";
import {
  buildExtractionInputContext,
  formatExtractionTranscript,
} from "../maintenance/extraction-context.js";

// ─── buildExtractionMessages: isContextOnly flag ───

const chat = [
  { is_user: false, is_system: true, mes: "greeting" },
  { is_user: true, is_system: false, mes: "user-1" },
  { is_user: false, is_system: false, mes: "assistant-1" },
  { is_user: true, is_system: false, mes: "user-2" },
  { is_user: false, is_system: false, mes: "assistant-2" },
  { is_user: true, is_system: false, mes: "user-3" },
  { is_user: false, is_system: false, mes: "assistant-3" },
];

{
  const messages = buildExtractionMessages(chat, 4, 6, {
    extractContextTurns: 2,
  });
  const contextOnly = messages.filter((m) => m.isContextOnly);
  const target = messages.filter((m) => !m.isContextOnly);

  assert.ok(
    contextOnly.length > 0,
    "should have context-only messages when extractContextTurns > 0",
  );
  assert.ok(
    target.length > 0,
    "should have extraction target messages",
  );
  assert.ok(
    contextOnly.every((m) => m.seq < 4),
    "context-only messages should have seq < startIdx",
  );
  assert.ok(
    target.every((m) => m.seq >= 4),
    "target messages should have seq >= startIdx",
  );
  console.log("  ✓ buildExtractionMessages: isContextOnly flag marks context vs target");
}

{
  const messages = buildExtractionMessages(chat, 2, 6, {
    extractContextTurns: 0,
  });
  const contextOnly = messages.filter((m) => m.isContextOnly);
  assert.equal(
    contextOnly.length,
    0,
    "no context-only messages when extractContextTurns=0 and startIdx=2",
  );
  console.log("  ✓ buildExtractionMessages: no context-only when contextTurns=0");
}

{
  const messages = buildExtractionMessages(chat, 1, 6, {
    extractContextTurns: 2,
  });
  const contextOnly = messages.filter((m) => m.isContextOnly);
  assert.equal(
    contextOnly.length,
    0,
    "no context-only when startIdx is already at the beginning",
  );
  console.log("  ✓ buildExtractionMessages: no context-only when startIdx at beginning");
}

// ─── formatExtractionTranscript: section dividers ───

{
  const mixed = [
    { seq: 1, role: "user", content: "context user", speaker: "A", isContextOnly: true },
    {
      seq: 2,
      role: "assistant",
      content: "context ai",
      speaker: "B",
      hideSpeakerLabel: true,
      isContextOnly: true,
    },
    { seq: 3, role: "user", content: "target user", speaker: "A", isContextOnly: false },
    {
      seq: 4,
      role: "assistant",
      content: "target ai",
      speaker: "B",
      hideSpeakerLabel: true,
      isContextOnly: false,
    },
  ];
  const transcript = formatExtractionTranscript(mixed);
  assert.match(transcript, /已提取过/, "transcript should contain context review header");
  assert.match(transcript, /本次需要提取/, "transcript should contain extraction target header");
  assert.ok(
    transcript.indexOf("已提取过") < transcript.indexOf("本次需要提取"),
    "context header should appear before target header",
  );
  assert.match(transcript, /#1.*context user/, "context message should appear");
  assert.match(transcript, /#3.*target user/, "target message should appear");
  assert.match(transcript, /#2 \[assistant\]: context ai/, "assistant card name should be hidden");
  assert.doesNotMatch(transcript, /#2 \[assistant\|B\]:/, "assistant card name should not be rendered");
  console.log("  ✓ formatExtractionTranscript: section dividers for mixed context/target");
}

{
  const allTarget = [
    { seq: 3, role: "user", content: "user msg", speaker: "A", isContextOnly: false },
    { seq: 4, role: "assistant", content: "ai msg", speaker: "B", isContextOnly: false },
  ];
  const transcript = formatExtractionTranscript(allTarget);
  assert.doesNotMatch(transcript, /已提取过/, "no context header when all are target");
  assert.doesNotMatch(transcript, /本次需要提取/, "no target header when all are target");
  console.log("  ✓ formatExtractionTranscript: no dividers when all messages are targets");
}

{
  const allContext = [
    { seq: 1, role: "user", content: "user msg", speaker: "A", isContextOnly: true },
    { seq: 2, role: "assistant", content: "ai msg", speaker: "B", isContextOnly: true },
  ];
  const transcript = formatExtractionTranscript(allContext);
  assert.doesNotMatch(transcript, /已提取过/, "no dividers when all are context-only");
  assert.doesNotMatch(transcript, /本次需要提取/, "no dividers when all are context-only");
  console.log("  ✓ formatExtractionTranscript: no dividers when all messages are context-only");
}

// ─── buildExtractionInputContext: isContextOnly propagation ───

{
  const inputMessages = [
    { seq: 1, role: "user", content: "old question", name: "A", speaker: "A", isContextOnly: true },
    { seq: 2, role: "assistant", content: "old answer", name: "B", speaker: "B", isContextOnly: true },
    { seq: 3, role: "user", content: "new question", name: "A", speaker: "A", isContextOnly: false },
    { seq: 4, role: "assistant", content: "new answer", name: "B", speaker: "B", isContextOnly: false },
  ];
  const result = buildExtractionInputContext(inputMessages, {
    settings: {},
    userName: "A",
    charName: "B",
  });
  const contextFiltered = result.filteredMessages.filter((m) => m.isContextOnly);
  const targetFiltered = result.filteredMessages.filter((m) => !m.isContextOnly);
  assert.equal(contextFiltered.length, 2, "context messages propagated through filtering");
  assert.equal(targetFiltered.length, 2, "target messages propagated through filtering");
  assert.equal(
    result.filteredMessages.find((m) => m.seq === 2)?.hideSpeakerLabel,
    true,
    "active character assistant label should be hidden",
  );
  assert.equal(
    result.filteredMessages.find((m) => m.seq === 1)?.hideSpeakerLabel,
    false,
    "user label should remain visible",
  );
  assert.match(result.filteredTranscript, /已提取过/, "transcript includes context header");
  assert.match(result.filteredTranscript, /本次需要提取/, "transcript includes target header");
  assert.match(result.filteredTranscript, /#2 \[assistant\]: old answer/, "assistant transcript should hide character name");
  assert.doesNotMatch(result.filteredTranscript, /#2 \[assistant\|B\]:/, "assistant transcript should not show character name");
  console.log("  ✓ buildExtractionInputContext: isContextOnly propagated to filteredMessages and transcript");
}

console.log("extraction-context-only-flag tests passed");
