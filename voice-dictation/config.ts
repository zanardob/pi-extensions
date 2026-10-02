/**
 * Configuration loading and credential resolution for Voice Dictation.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH =
  process.env.VOICE_DICTATION_CONFIG || join(homedir(), ".pi", "agent", "voice-dictation.json");
export const STT_CONFIG_PATH = join(homedir(), ".pi", "agent", "stt.json");
export const DIR = join(homedir(), ".pi", "agent", "voice-dictation");
export const VOICE_BIN = process.env.VOICE_DICTATION_BIN || join(DIR, "apple-voice");
export const BATCH_BIN = process.env.VOICE_DICTATION_STT_BIN || join(DIR, "apple-stt");

export type ProviderChoice = "auto" | "deepgram" | "apple";

export type DeepgramConfig = {
  apiKeyEnv: string;
  apiKey: string;
  keychainService: string;
  model: string;
  language: string;
  endpointingMs: number;
};

export type CaptureConfig = {
  ffmpegPath: string;
  input: string;
};

export type VoiceConfig = {
  keybind: string;
  provider: ProviderChoice;
  locale: string;
  context: boolean;
  extraTerms: string[];
  fileProvider: ProviderChoice;
  capture: CaptureConfig;
  deepgram: DeepgramConfig;
};

const defaults: VoiceConfig = {
  keybind: "alt+v",
  provider: "auto",
  locale: "",
  context: true,
  extraTerms: [],
  fileProvider: "auto",
  capture: { ffmpegPath: "ffmpeg", input: ":0" },
  deepgram: {
    apiKeyEnv: "DEEPGRAM_API_KEY",
    apiKey: "",
    keychainService: "",
    model: "nova-3",
    language: "",
    endpointingMs: 300,
  },
};

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function providerOr(value: unknown, fallback: ProviderChoice): ProviderChoice {
  return value === "deepgram" || value === "apple" || value === "auto" ? value : fallback;
}

export function loadConfig(): VoiceConfig {
  const raw = readJson(CONFIG_PATH);
  const rawDeepgram = objectFrom(raw.deepgram);
  const rawCapture = objectFrom(raw.capture);
  return {
    keybind: process.env.VOICE_DICTATION_KEYBIND || stringOr(raw.keybind, defaults.keybind),
    provider: providerOr(raw.provider, defaults.provider),
    locale: stringOr(raw.locale, defaults.locale),
    context: raw.context !== false,
    extraTerms: Array.isArray(raw.extraTerms) ? raw.extraTerms.filter((t): t is string => typeof t === "string") : [],
    fileProvider: providerOr(raw.fileProvider, defaults.fileProvider),
    capture: {
      ffmpegPath: stringOr(rawCapture.ffmpegPath, defaults.capture.ffmpegPath),
      input: stringOr(rawCapture.input, defaults.capture.input),
    },
    deepgram: {
      apiKeyEnv: stringOr(rawDeepgram.apiKeyEnv, defaults.deepgram.apiKeyEnv),
      apiKey: stringOr(rawDeepgram.apiKey, defaults.deepgram.apiKey),
      keychainService: stringOr(rawDeepgram.keychainService, defaults.deepgram.keychainService),
      model: stringOr(rawDeepgram.model, defaults.deepgram.model),
      language: stringOr(rawDeepgram.language, defaults.deepgram.language),
      endpointingMs: typeof rawDeepgram.endpointingMs === "number" ? rawDeepgram.endpointingMs : defaults.deepgram.endpointingMs,
    },
  };
}

/** pi-voice-stt's stt.json provider.language, reused as the default locale. */
export function sttLanguage(): string {
  const provider = objectFrom(readJson(STT_CONFIG_PATH).provider);
  return typeof provider.language === "string" ? provider.language : "";
}

type ExecFn = (command: string, args: string[]) => Promise<{ stdout: string; code: number }>;

/** Deepgram key lookup: environment variable, then config, then macOS Keychain. */
export async function resolveDeepgramKey(deepgram: DeepgramConfig, exec: ExecFn): Promise<string> {
  const envName = (deepgram.apiKeyEnv || "DEEPGRAM_API_KEY").trim();
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv?.trim()) return fromEnv.trim();
  if (deepgram.apiKey.trim()) return deepgram.apiKey.trim();
  if (deepgram.keychainService.trim()) {
    try {
      const { stdout, code } = await exec("security", ["find-generic-password", "-s", deepgram.keychainService.trim(), "-w"]);
      if (code === 0 && stdout.trim()) return stdout.trim();
    } catch {
      /* keychain lookup unavailable */
    }
  }
  return "";
}

/** BCP-47-ish language for Deepgram ("en-GB-u-rg-…" -> "en-GB", "" -> system). */
export function deepgramLanguage(config: VoiceConfig, locale: string): string {
  if (config.deepgram.language.trim()) return config.deepgram.language.trim();
  const value = (locale || Intl.DateTimeFormat().resolvedOptions().locale || "en").trim();
  const parts = value.split("-");
  if (parts.length >= 2 && /^[A-Za-z]{2}$/.test(parts[1])) {
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  }
  return (parts[0] || "en").toLowerCase();
}
