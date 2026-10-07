export type ExternalLlmProvider = "openai" | "anthropic";

export type ExternalLlmConfig = {
  provider: ExternalLlmProvider;
  baseURL: string;
  apiKey: string;
  model: string;
};

export const SUBTITLE_LLM_CONFIG_STORAGE_KEY = "code-tape:subtitle-llm";

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ExternalLlmProvider>(["openai", "anthropic"]);

// Keys are session-scoped unless the user explicitly opts into remembering them.
export function loadExternalLlmConfig(
  storage?: Pick<Storage, "getItem">,
): ExternalLlmConfig | null {
  const selected = storage ?? safeStorage("session");
  if (!selected) return null;
  let raw: string | null;
  try {
    raw = selected.getItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
    if (!raw && !storage) {
      const persisted = safeStorage("local")?.getItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
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

export function saveExternalLlmConfig(
  config: ExternalLlmConfig,
  storage?: Pick<Storage, "setItem">,
  options: { rememberKey?: boolean } = {},
): void {
  const selected = storage ?? safeStorage("session");
  if (!selected) return;
  try {
    const value = normalizeConfigStrict(config);
    selected.setItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY, JSON.stringify(value));
    if (!storage) {
      if (options.rememberKey)
        safeStorage("local")?.setItem(
          SUBTITLE_LLM_CONFIG_STORAGE_KEY,
          JSON.stringify({ ...value, rememberKey: true }),
        );
      else safeStorage("local")?.removeItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
    }
  } catch {
    // localStorage can be unavailable (private mode / disabled). Config simply
    // does not persist; the app falls back to the local model.
  }
}

export function clearExternalLlmConfig(storage?: Pick<Storage, "removeItem">): void {
  try {
    if (storage) storage.removeItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
    else {
      safeStorage("session")?.removeItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
      safeStorage("local")?.removeItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function isExternalLlmConfigured(
  config: ExternalLlmConfig | null,
): config is ExternalLlmConfig {
  if (!config) return false;
  return (
    VALID_PROVIDERS.has(config.provider) &&
    config.baseURL.trim().length > 0 &&
    config.apiKey.trim().length > 0 &&
    config.model.trim().length > 0
  );
}

function normalizeConfig(value: unknown): ExternalLlmConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) return null;
  return {
    provider: provider as ExternalLlmProvider,
    baseURL: typeof record.baseURL === "string" ? record.baseURL.trim() : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    model: typeof record.model === "string" ? record.model.trim() : "",
  };
}

function normalizeConfigStrict(config: ExternalLlmConfig): ExternalLlmConfig {
  return {
    provider: config.provider,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
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
