const SCRIPT_MARKER = "data-st-bme-v9-dexie";
let browserLoad = null;

export async function loadDexie(explicitClass = null) {
  if (typeof explicitClass === "function") return explicitClass;
  if (typeof globalThis.Dexie === "function") return globalThis.Dexie;

  if (typeof globalThis.document === "undefined") {
    const imported = await import("dexie");
    return imported.default || imported.Dexie || imported;
  }

  if (!browserLoad) {
    browserLoad = new Promise((resolve, reject) => {
      const document = globalThis.document;
      const existing = document.querySelector?.(`script[${SCRIPT_MARKER}]`);
      const script = existing || document.createElement("script");
      const finish = () => {
        if (typeof globalThis.Dexie === "function") resolve(globalThis.Dexie);
        else reject(new Error("Dexie loaded without a global constructor"));
      };
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Dexie failed to load")), {
        once: true,
      });
      if (existing) {
        if (typeof globalThis.Dexie === "function") finish();
        return;
      }
      script.async = true;
      script.src = new URL("../../lib/dexie.min.js", import.meta.url).toString();
      script.setAttribute(SCRIPT_MARKER, "");
      const mount = document.head || document.documentElement || document.body;
      if (!mount) {
        reject(new Error("Dexie script has no document mount point"));
        return;
      }
      mount.appendChild(script);
    }).catch((error) => {
      browserLoad = null;
      throw error;
    });
  }
  return browserLoad;
}
