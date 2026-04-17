/**
 * Opt-in telemetry (wave 4.4).
 *
 * Off by default. When a user explicitly enables it, emits the tiniest
 * payload that still tells the maintainers whether the app is healthy:
 *   - app version
 *   - platform string
 *   - redacted error class + count
 *   - session duration bucket (opt-in separately)
 *
 * Never sends session content, prompts, transcripts, user identifiers, or
 * provider names. The endpoint and the opt-in flag live in localStorage so
 * users retain local control, and the first-launch card exposes them both.
 *
 * Payloads pass through the same redactor used by `apiLogger` so the
 * conservative "no secrets leave the machine" invariant holds even if a
 * bug ever caused us to include extra fields.
 */

import { redactValue } from "../utils/redact";

const STORAGE_KEY = "socratic-council-telemetry-v1";
const DEFAULT_ENDPOINT = "";

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  /** ISO date string when the user accepted — shown in Settings → Privacy. */
  acceptedAt: string | null;
}

const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: false,
  endpoint: DEFAULT_ENDPOINT,
  acceptedAt: null,
};

export function loadTelemetryConfig(): TelemetryConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<TelemetryConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      endpoint:
        typeof parsed.endpoint === "string" && parsed.endpoint.trim() !== ""
          ? parsed.endpoint.trim()
          : DEFAULT_ENDPOINT,
      acceptedAt: typeof parsed.acceptedAt === "string" ? parsed.acceptedAt : null,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveTelemetryConfig(config: TelemetryConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore quota errors */
  }
}

export function setTelemetryEnabled(enabled: boolean, endpoint?: string): TelemetryConfig {
  const current = loadTelemetryConfig();
  const next: TelemetryConfig = {
    enabled,
    endpoint: endpoint ?? current.endpoint,
    acceptedAt: enabled ? new Date().toISOString() : current.acceptedAt,
  };
  saveTelemetryConfig(next);
  return next;
}

export interface TelemetryEvent {
  /** Short category — "launch" | "error" | "release_check", etc. */
  kind: string;
  /** Optional small payload — everything is redacted before send. */
  payload?: Record<string, unknown>;
}

const APP_VERSION = "1.0.0";

function buildPayload(event: TelemetryEvent): unknown {
  return redactValue({
    at: new Date().toISOString(),
    appVersion: APP_VERSION,
    platform:
      typeof navigator !== "undefined" && typeof navigator.platform === "string"
        ? navigator.platform
        : "unknown",
    kind: event.kind,
    ...(event.payload ? { payload: event.payload } : {}),
  });
}

/**
 * Emit one event. No-op when telemetry is disabled or no endpoint is
 * configured. Silently swallows network errors — telemetry must never
 * degrade the user's experience.
 */
export async function emit(event: TelemetryEvent): Promise<void> {
  const config = loadTelemetryConfig();
  if (!config.enabled) return;
  if (!config.endpoint || config.endpoint.trim() === "") return;

  const body = JSON.stringify(buildPayload(event));
  try {
    await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // Fire-and-forget: short timeout so the app isn't held up.
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* telemetry must never surface errors to the user */
  }
}
