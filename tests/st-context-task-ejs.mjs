import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const extensionsShimSource = [
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../extensions.js") {
      return {
        shortCircuit: true,
        url: extensionsShimUrl,
      };
    }
    return nextResolve(specifier, context);
  },
});

const originalSillyTavern = globalThis.SillyTavern;
const originalGetCurrentChatId = globalThis.getCurrentChatId;
const originalEjs = globalThis.ejs;

try {
  globalThis.getCurrentChatId = () => "chat-from-global";
  globalThis.SillyTavern = {
    getContext() {
      return {
        name1: "User",
        name2: "Alice",
        name1_description: "旧 persona 字段",
        powerUserSettings: {
          persona_description: "桥接 persona",
          persona_description_lorebook: "persona-book",
        },
        extensionSettings: {
          persona_description: "扩展 persona",
          variables: {
            global: {
              score: 7,
            },
          },
        },
        characterId: 0,
        characters: [
          {
            avatar: "alice.png",
            data: {
              description: "角色描述",
              extensions: {
                world: "char-book",
              },
            },
          },
        ],
        chatMetadata: {
          world: "chat-book",
          variables: {
            location: "library",
          },
        },
        chat: [
          { is_user: true, mes: "第一句" },
          {
            is_user: false,
            mes: "回应",
            variables: {
              0: {
                mood: "calm",
              },
            },
          },
          { is_user: true, mes: "最后一句" },
        ],
        onlineStatus: "gpt-test",
        selectedGroupId: 42,
      };
    },
  };

  const { getSTContextForPrompt, getSTContextSnapshot } =
    await import("../st-context.js");
  const {
    substituteTaskEjsParams,
    createTaskEjsRenderContext,
    evalTaskEjsTemplate,
    checkTaskEjsSyntax,
    inspectTaskEjsRuntimeBackend,
  } = await import("../task-ejs.js");

  const promptContext = getSTContextForPrompt();
  assert.deepEqual(promptContext, {
    userPersona: "桥接 persona",
    charDescription: "角色描述",
    charName: "Alice",
    userName: "User",
    currentTime: promptContext.currentTime,
  });

  const hostSnapshot = getSTContextSnapshot();
  assert.equal(hostSnapshot.snapshot.persona.text, "桥接 persona");
  assert.equal(hostSnapshot.snapshot.character.description, "角色描述");
  assert.equal(hostSnapshot.snapshot.character.worldbook, "char-book");
  assert.equal(hostSnapshot.snapshot.worldbook.persona, "persona-book");
  assert.equal(hostSnapshot.snapshot.worldbook.chat, "chat-book");
  assert.equal(hostSnapshot.snapshot.variables.global.score, 7);
  assert.equal(hostSnapshot.snapshot.variables.local.location, "library");
  assert.equal(hostSnapshot.snapshot.chat.lastUserMessage, "最后一句");
  assert.equal(hostSnapshot.snapshot.chat.id, "chat-from-global");
  assert.equal(hostSnapshot.prompt.charName, "Alice");
  assert.equal(hostSnapshot.prompt.userPersona, "桥接 persona");

  const substitution = substituteTaskEjsParams(
    "{{charName}}|{{userPersona}}|{{hostSnapshot.worldbook.chat}}|{{stSnapshot.chat.lastUserMessage}}",
    {},
    { hostSnapshot },
  );
  assert.equal(substitution, "Alice|桥接 persona|chat-book|最后一句");

  const compileCalls = [];
  globalThis.ejs = {
    compile(template) {
      compileCalls.push(template);
      if (template === "<% broken") {
        throw new Error("Unexpected end of input");
      }
      if (template === "<% await execute() %>") {
        return async function compiled(locals) {
          await locals.execute();
          return "";
        };
      }
      return async function compiled(locals) {
        return [
          locals.charName,
          locals.userName,
          locals.userLoreBook,
          locals.chatLoreBook,
          locals.variables.score,
          locals.variables.location,
          locals.lastUserMessage,
          locals.recentMessages,
          locals.persona,
          locals.hostSnapshot.character.worldbook,
          locals.stSnapshot.chat.lastUserMessage,
          typeof locals.execute,
        ].join("|");
      };
    },
  };

  const renderCtx = createTaskEjsRenderContext([], {
    hostSnapshot,
    templateContext: {
      user: "AliasUser",
      char: "AliasAlice",
      userName: "AliasUser",
      charName: "AliasAlice",
      recentMessages: "最近上下文",
      persona: "AliasPersona",
    },
  });
  const primaryBackend = await inspectTaskEjsRuntimeBackend({
    ensureRuntime: false,
  });
  assert.equal(primaryBackend.status, "primary");
  assert.equal(primaryBackend.isAvailable, true);
  assert.equal(primaryBackend.isFallback, false);

  const syntaxOk = await checkTaskEjsSyntax("<%= 1 %>");
  assert.equal(syntaxOk, null);

  const rendered = await evalTaskEjsTemplate("<%= 1 %>", renderCtx);
  assert.equal(
    rendered,
    "AliasAlice|AliasUser|persona-book|chat-book|7|library|最后一句|最近上下文|AliasPersona|char-book|最后一句|function",
  );
  assert.deepEqual(compileCalls, ["<%= 1 %>", "<%= 1 %>"]);

  await assert.rejects(
    () => evalTaskEjsTemplate("<% await execute() %>", renderCtx),
    (error) =>
      error?.code === "st_bme_task_ejs_unsupported_helper" &&
      error?.helperName === "execute",
  );

  const syntaxError = await checkTaskEjsSyntax("<% broken");
  assert.equal(syntaxError, "Unexpected end of input");

  delete globalThis.ejs;
  const failedBackend = await inspectTaskEjsRuntimeBackend({
    ensureRuntime: false,
  });
  assert.equal(failedBackend.status, "failed");
  assert.equal(failedBackend.isAvailable, false);
  assert.equal(failedBackend.isFallback, false);

  const passthrough = await evalTaskEjsTemplate("{{charName}}", renderCtx);
  assert.equal(passthrough, "AliasAlice");
} finally {
  globalThis.SillyTavern = originalSillyTavern;
  globalThis.getCurrentChatId = originalGetCurrentChatId;
  globalThis.ejs = originalEjs;
}
