import { register, registerHooks } from "node:module";

export function toDataModuleUrl(source = "") {
  return `data:text/javascript,${encodeURIComponent(String(source || ""))}`;
}

export function installResolveHooks(entries = []) {
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      specifiers: Array.isArray(entry?.specifiers)
        ? entry.specifiers.map((value) => String(value || "")).filter(Boolean)
        : [],
      url: String(entry?.url || ""),
    }))
    .filter((entry) => entry.specifiers.length > 0 && entry.url);

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        for (const entry of normalizedEntries) {
          if (entry.specifiers.includes(specifier)) {
            return {
              shortCircuit: true,
              url: entry.url,
            };
          }
        }
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  if (typeof register === "function") {
    const loaderSource = `
const entries = ${JSON.stringify(normalizedEntries)};
export async function resolve(specifier, context, nextResolve) {
  for (const entry of entries) {
    if (Array.isArray(entry.specifiers) && entry.specifiers.includes(specifier)) {
      return {
        shortCircuit: true,
        url: entry.url,
      };
    }
  }
  return nextResolve(specifier, context);
}
`;
    register(toDataModuleUrl(loaderSource), import.meta.url);
    return;
  }

  throw new Error("No compatible module hook API available");
}
