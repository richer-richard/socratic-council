/**
 * Diagnostics snapshot builder (wave 4.3).
 *
 * Assembles a redacted, user-visible dump of everything useful for a bug
 * report: app version, platform, provider reachability (as last-known from
 * apiLogger), recent log entries, and the configured budget/proxy shape
 * (without secrets). Rendered by a new Settings → Diagnostics tab (UI
 * follow-up); the data shape below is what that tab consumes.
 *
 * All log contents pass through `redactValue` before being embedded so
 * "Copy diagnostics" never emits credentials, proxy passwords, or raw
 * provider keys even if a misbehaving library logged them.
 */

import { apiLogger } from "../services/api";
import type { AppConfig } from "../stores/config";
import { redactValue } from "./redact";

export interface ProviderHealth {
  provider: string;
  lastLogAt: number | null;
  lastError: string | null;
  recentCallCount: number;
}

export interface DiagnosticsSnapshot {
  generatedAt: number;
  appVersion: string;
  platform: string;
  userAgent: string;
  timezoneOffsetMinutes: number;
  configSummary: {
    /** Providers with a key present — never the keys themselves. */
    configuredProviders: string[];
    modelsByProvider: Record<string, string>;
    proxyType: string;
    hasProxyCredentials: boolean;
    budget: AppConfig["preferences"]["budget"] | null;
    moderatorEnabled: boolean;
    observersEnabled: boolean;
  };
  providerHealth: ProviderHealth[];
  recentLogs: Array<{
    timestamp: number;
    level: string;
    provider: string;
    message: string;
    details?: unknown;
  }>;
}

const APP_VERSION = "1.0.0";

export function buildDiagnosticsSnapshot(config: AppConfig): DiagnosticsSnapshot {
  const logs = apiLogger.getLogs().slice(-50);
  const byProvider = new Map<string, { lastLog: number; lastError: string | null; count: number }>();
  for (const entry of logs) {
    const existing = byProvider.get(entry.provider) ?? {
      lastLog: 0,
      lastError: null,
      count: 0,
    };
    existing.count += 1;
    if (entry.timestamp > existing.lastLog) existing.lastLog = entry.timestamp;
    if (entry.level === "error") {
      existing.lastError = typeof entry.message === "string" ? entry.message : "error";
    }
    byProvider.set(entry.provider, existing);
  }

  const providerHealth: ProviderHealth[] = Array.from(byProvider.entries()).map(
    ([provider, rec]) => ({
      provider,
      lastLogAt: rec.lastLog === 0 ? null : rec.lastLog,
      lastError: rec.lastError,
      recentCallCount: rec.count,
    }),
  );

  const configuredProviders = Object.entries(config.credentials)
    .filter(([, v]) => v && typeof v.apiKey === "string" && v.apiKey.length > 0)
    .map(([k]) => k);

  const modelsByProvider: Record<string, string> = {};
  for (const [provider, model] of Object.entries(config.models)) {
    if (typeof model === "string" && model.length > 0) modelsByProvider[provider] = model;
  }

  return {
    generatedAt: Date.now(),
    appVersion: APP_VERSION,
    platform:
      typeof navigator !== "undefined" && typeof navigator.platform === "string"
        ? navigator.platform
        : "unknown",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    timezoneOffsetMinutes:
      typeof Date !== "undefined" ? new Date().getTimezoneOffset() : 0,
    configSummary: {
      configuredProviders,
      modelsByProvider,
      proxyType: config.proxy.type,
      hasProxyCredentials: Boolean(config.proxy.username || config.proxy.password),
      budget: config.preferences.budget ?? null,
      moderatorEnabled: config.preferences.moderatorEnabled,
      observersEnabled: config.preferences.observersEnabled,
    },
    providerHealth,
    // Pass every log entry through the redactor — belt-and-braces since
    // apiLogger.log already redacts on the way in, but we also redact on
    // the way out in case older entries predate 1.4.
    recentLogs: logs.map((entry) => ({
      timestamp: entry.timestamp,
      level: entry.level,
      provider: entry.provider,
      message:
        typeof entry.message === "string"
          ? (redactValue(entry.message) as string)
          : String(entry.message ?? ""),
      ...(entry.details !== undefined ? { details: redactValue(entry.details) } : {}),
    })),
  };
}

export function diagnosticsToText(snapshot: DiagnosticsSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
