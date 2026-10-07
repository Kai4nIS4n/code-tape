export type ExternalAsrProvider = "openai-compatible";

export type ExternalAsrConfig = {
  provider: ExternalAsrProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  language: string;
};

export const SUBTITLE_ASR_CONFIG_STORAGE_KEY = "code-tape:subtitle-asr";

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ExternalAsrProvider>(["openai-compatible"]);

export function loadExternalAsrConfig(
  storage?: Pick<Storage, "getItem">,
): ExternalAsrConfig | null {
  const selected = storage ?? safeStorage("session");
  if (!selected) return null;
  let raw: string | null;
  try {
    raw = selected.getItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
    if (!raw && !storage) {
      const persisted = safeStorage("local")?.getItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
      if (persisted && JSON.parse(persisted).rememberKey === true) raw = persisted;
    }
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveExternalAsrConfig(
  config: ExternalAsrConfig,
  storage?: Pick<Storage, "setItem">,
  options: { rememberKey?: boolean } = {},
): void {
  const selected = storage ?? safeStorage("session");
  if (!selected) return;
  try {
    const value = normalizeConfigStrict(config);
    selected.setItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY, JSON.stringify(value));
    if (!storage) {
      if (options.rememberKey)
        safeStorage("local")?.setItem(
          SUBTITLE_ASR_CONFIG_STORAGE_KEY,
          JSON.stringify({ ...value, rememberKey: true }),
        );
      else safeStorage("local")?.removeItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
    }
  } catch {
    // localStorage can be unavailable; the app simply keeps using local ASR.
  }
}

export function clearExternalAsrConfig(storage?: Pick<Storage, "removeItem">): void {
  try {
    if (storage) storage.removeItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
    else {
      safeStorage("session")?.removeItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
      safeStorage("local")?.removeItem(SUBTITLE_ASR_CONFIG_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function isExternalAsrConfigured(
  config: ExternalAsrConfig | null,
): config is ExternalAsrConfig {
  if (!config) return false;
  return (
    VALID_PROVIDERS.has(config.provider) &&
    config.baseURL.trim().length > 0 &&
    config.apiKey.trim().length > 0 &&
    config.model.trim().length > 0
  );
}

function normalizeConfig(value: unknown): ExternalAsrConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) return null;
  return {
    provider: provider as ExternalAsrProvider,
    baseURL: typeof record.baseURL === "string" ? record.baseURL.trim() : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    model: typeof record.model === "string" ? record.model.trim() : "",
    language: typeof record.language === "string" ? record.language.trim() : "",
  };
}

function normalizeConfigStrict(config: ExternalAsrConfig): ExternalAsrConfig {
  return {
    provider: config.provider,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    language: config.language.trim(),
  };
}

function safeStorage(kind: "local" | "session"): Storage | undefined {
  try {
    return typeof globalThis !== "undefined"
      ? kind === "session"
        ? globalThis.sessionStorage
        : globalThis.localStorage
      : undefined;
  } catch {
    return undefined;
  }
}
