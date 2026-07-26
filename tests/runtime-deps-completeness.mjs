import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHECKS = [
  {
    modulePath: "sync/graph-persistence-io.js",
    builderName: "createGraphPersistenceIoRuntime",
  },
  {
    modulePath: "sync/graph-load-persist.js",
    builderName: "createGraphLoadPersistRuntime",
  },
  {
    modulePath: "sync/graph-mutation-gate.js",
    builderName: "createGraphMutationGateRuntime",
  },
];

function readProjectFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function stripCommentsAndStrings(source) {
  let output = "";
  let i = 0;

  const appendSpacePreservingNewlines = (text) => {
    output += text.replace(/[^\n\r]/g, " ");
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i += 1;
      appendSpacePreservingNewlines(source.slice(start, i));
      continue;
    }

    if (char === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(source.length, i + 2);
      appendSpacePreservingNewlines(source.slice(start, i));
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      appendSpacePreservingNewlines(source.slice(start, i));
      continue;
    }

    if (char === "`") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i += 1;
          break;
        }
        i += 1;
      }
      appendSpacePreservingNewlines(source.slice(start, i));
      continue;
    }

    output += char;
    i += 1;
  }

  return output;
}

function findMatchingBrace(strippedSource, openIndex) {
  if (strippedSource[openIndex] !== "{") {
    throw new Error(`Expected opening brace at offset ${openIndex}`);
  }

  let depth = 0;
  for (let i = openIndex; i < strippedSource.length; i += 1) {
    if (strippedSource[i] === "{") depth += 1;
    if (strippedSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`No matching closing brace for offset ${openIndex}`);
}

function extractRuntimeKeys(moduleSource) {
  const stripped = stripCommentsAndStrings(moduleSource);
  const unsupportedComputedAccess = /\bruntime\s*(?:\?\.)?\s*\[/.exec(stripped);
  if (unsupportedComputedAccess) {
    throw new Error(
      `Unsupported computed runtime dependency access near offset ${unsupportedComputedAccess.index}. ` +
        "Use direct runtime.someDependency access so completeness can be checked.",
    );
  }
  const keys = new Set();
  const runtimePropertyPattern = /\bruntime\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
  let match = null;

  while ((match = runtimePropertyPattern.exec(stripped))) {
    keys.add(match[1]);
  }

  return keys;
}

function extractBuilderReturnObjectRange(indexSource, builderName) {
  const stripped = stripCommentsAndStrings(indexSource);
  const functionPattern = new RegExp(`\\bfunction\\s+${builderName}\\s*\\(`);
  const functionMatch = functionPattern.exec(stripped);
  if (!functionMatch) {
    throw new Error(`Could not locate builder function ${builderName}`);
  }

  const functionBodyOpen = stripped.indexOf("{", functionMatch.index + functionMatch[0].length);
  if (functionBodyOpen < 0) {
    throw new Error(`Could not locate function body for ${builderName}`);
  }
  const functionBodyClose = findMatchingBrace(stripped, functionBodyOpen);

  const returnPattern = /\breturn\b/g;
  returnPattern.lastIndex = functionBodyOpen + 1;
  let returnMatch = null;

  while ((returnMatch = returnPattern.exec(stripped)) && returnMatch.index < functionBodyClose) {
    let cursor = returnMatch.index + returnMatch[0].length;
    while (cursor < functionBodyClose && /\s/.test(stripped[cursor])) cursor += 1;
    if (stripped[cursor] === "{") {
      const objectOpen = cursor;
      const objectClose = findMatchingBrace(stripped, objectOpen);
      if (objectClose > functionBodyClose) {
        throw new Error(`Return object for ${builderName} extends beyond function body`);
      }
      return { open: objectOpen, close: objectClose, stripped };
    }
  }

  throw new Error(`Could not locate returned object literal for ${builderName}`);
}

function splitTopLevelObjectEntries(strippedSource, open, close) {
  const entries = [];
  let depth = 0;
  let entryStart = open + 1;

  for (let i = open + 1; i < close; i += 1) {
    const char = strippedSource[i];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      entries.push(strippedSource.slice(entryStart, i));
      entryStart = i + 1;
    }
  }

  entries.push(strippedSource.slice(entryStart, close));
  return entries;
}

function extractBuilderProvidedKeys(indexSource, builderName) {
  const { open, close, stripped } = extractBuilderReturnObjectRange(indexSource, builderName);
  const entries = splitTopLevelObjectEntries(stripped, open, close);
  const keys = new Set();

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith("...")) continue;

    const keyedEntryMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(entry);
    if (keyedEntryMatch) {
      keys.add(keyedEntryMatch[1]);
      continue;
    }

    const methodEntryMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(entry);
    if (methodEntryMatch) {
      keys.add(methodEntryMatch[1]);
      continue;
    }

    const shorthandEntryMatch = /^([A-Za-z_$][\w$]*)$/.exec(entry);
    if (shorthandEntryMatch) {
      keys.add(shorthandEntryMatch[1]);
    }
  }

  return keys;
}

function diffSets(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function assertRuntimeDepsComplete({ modulePath, builderName, moduleSource, indexSource }) {
  const requiredKeys = extractRuntimeKeys(moduleSource);
  const providedKeys = extractBuilderProvidedKeys(indexSource, builderName);
  const missingKeys = diffSets(requiredKeys, providedKeys);

  if (missingKeys.length > 0) {
    throw new Error(
      `${modulePath} requires runtime deps missing from ${builderName}: ${missingKeys.join(", ")}`,
    );
  }

  return {
    requiredKeys,
    providedKeys,
    unusedProvidedKeys: diffSets(providedKeys, requiredKeys),
  };
}

function runExtractorSelfChecks() {
  const runtimeKeys = extractRuntimeKeys(`
    runtime.used();
    runtime.value?.();
    runtime?.optional;
    // runtime.commentOnly();
    const stringOnly = "runtime.stringOnly";
    const templateOnly = ` + "`runtime.templateOnly`" + `;
  `);
  assert.deepEqual([...runtimeKeys].sort(), ["optional", "used", "value"]);
  assert.throws(
    () => extractRuntimeKeys("runtime[dynamicKey]();"),
    /Unsupported computed runtime dependency access/,
  );

  const syntheticIndex = `
    function createSyntheticRuntime() {
      return {
        used,
        value: () => ({ nested: true }),
        extra: (input) => {
          return { input };
        },
      };
    }
  `;
  const providedKeys = extractBuilderProvidedKeys(syntheticIndex, "createSyntheticRuntime");
  assert.deepEqual([...providedKeys].sort(), ["extra", "used", "value"]);

  assert.throws(
    () =>
      assertRuntimeDepsComplete({
        modulePath: "synthetic.js",
        builderName: "createSyntheticRuntime",
        moduleSource: "runtime.used(); runtime.missing();",
        indexSource: syntheticIndex,
      }),
    /synthetic\.js requires runtime deps missing from createSyntheticRuntime: missing/,
  );
}

runExtractorSelfChecks();

const indexSource = readProjectFile("index.js");
for (const check of CHECKS) {
  const result = assertRuntimeDepsComplete({
    ...check,
    moduleSource: readProjectFile(check.modulePath),
    indexSource,
  });

  if (result.unusedProvidedKeys.length > 0) {
    console.info(
      `[runtime-deps] ${check.builderName} provides unused keys for ${check.modulePath}: ${result.unusedProvidedKeys.join(", ")}`,
    );
  }
}

console.log("runtime dependency completeness checks passed");
