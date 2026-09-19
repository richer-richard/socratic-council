/**
 * Best-effort secret scrubber for log payloads, error messages, diagnostic
 * snapshots, and anything else that might surface in devtools or be copied to
 * a bug report.
 *
 * Rules (applied in order, conservative — we err on the side of over-redacting):
 *
 *   - `Authorization: Bearer <token>`     → `Authorization: Bearer [REDACTED]`
 *   - `x-api-key: <value>`                → `x-api-key: [REDACTED]`
 *   - `x-goog-api-key: <value>`           → `x-goog-api-key: [REDACTED]`
 *   - `Authorization` inside a JSON obj (case-insensitive key)
 *     `{"Authorization":"Bearer sk-..."}` → `{"Authorization":"[REDACTED]"}`
 *   - Proxy URL userinfo — `scheme://user:pass@host` → `scheme://[REDACTED]@host`
 *   - Raw provider-key prefixes in free text: `sk-...`, `sk-ant-...`,
 *     `AIza...` replaced with `[REDACTED]` when they appear as isolated tokens.
 *
 * Not a substitute for keeping secrets off of logs in the first place; this
 * is a defense-in-depth layer for anything that slips through.
 */

const REDACTED = "[REDACTED]";

/**
 * Exact secret values the app currently holds (provider API keys, the proxy
 * password), registered by the config store whenever they load or change.
 * Pattern rules below only know a few key *shapes*; a provider error that
 * echoes a key of any other shape (MiniMax JWTs, Zhipu `id.secret`, a custom
 * gateway token) is caught here by value instead.
 */
const KNOWN_SECRETS = new Set<string>();

export function registerKnownSecrets(values: Iterable<string | null | undefined>): void {
  KNOWN_SECRETS.clear();
  for (const value of values) {
    if (typeof value === "string" && value.length >= 8) KNOWN_SECRETS.add(value);
  }
}

function redactKnownSecrets(input: string): string {
  let out = input;
  for (const secret of KNOWN_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Header lines — matches `Authorization: Bearer xyz` and `x-api-key: xyz`
// styles, including common case variants. Captures the header name so it's
// preserved verbatim in the output.
const HEADER_PATTERNS: Array<{ re: RegExp; repl: string }> = [
  {
    re: /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"',]+/gi,
    repl: `$1${REDACTED}`,
  },
  {
    re: /(x-api-key\s*[:=]\s*)[^\s"',]+/gi,
    repl: `$1${REDACTED}`,
  },
  {
    re: /(x-goog-api-key\s*[:=]\s*)[^\s"',]+/gi,
    repl: `$1${REDACTED}`,
  },
];

// URL userinfo — matches the `scheme://user:pass@host` form, preserves everything
// except the userinfo segment.
const URL_USERINFO = /([a-z][a-z0-9+\-.]*:\/\/)[^@\s/?#]+@/gi;

// Isolated-token provider keys — conservative match on well-known prefixes so
// we don't mangle real prose. Keys typically contain only letters, digits,
// `-`, and `_`. Thresholds are set low enough to catch short-form test keys
// while high enough not to flag ordinary words.
//
// Fix 11.1: added xai- (Grok), ms-... (Anthropic-compatible MiniMax), and a
// generic high-entropy fallback that catches long base64-ish strings. The
// generic pattern requires ≥32 chars of base64-alphabet content to avoid
// flagging everyday hashes or git short SHAs.
const LOOSE_KEY_PATTERNS: RegExp[] = [
  // JWT-shaped (MiniMax keys): eyJ… . … . …
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  // Zhipu / Z.AI: 32 hex chars, a dot, 16+ alphanumerics.
  /\b([0-9a-f]{32}\.[A-Za-z0-9]{16,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{10,})\b/g,
  /\b(sk-proj-[A-Za-z0-9_-]{10,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{10,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{16,})\b/g,
  /\b(xai-[A-Za-z0-9_-]{16,})\b/g,
  /\b(ms-[A-Za-z0-9_-]{16,})\b/g,
  // Generic long-token fallback — looks like a base64 / hex secret. Bias
  // toward false positives to keep secrets out of logs.
  /\b([A-Za-z0-9+/=_-]{48,})\b/g,
];

function redactString(input: string): string {
  let out = redactKnownSecrets(input);
  for (const { re, repl } of HEADER_PATTERNS) out = out.replace(re, repl);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const re of LOOSE_KEY_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Recursively walk a value and redact string contents. Objects and arrays are
 * shallow-cloned; non-enumerable or exotic (Error, Map, Set) fall back to a
 * best-effort string conversion that is then redacted.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // guard against cycles and deep nesting
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return redactString(`${value.name}: ${value.message}\n${value.stack ?? ""}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Known-sensitive keys get their entire value redacted rather than
      // having the inner string scanned. Match case-insensitively.
      const lower = key.toLowerCase();
      if (lower === "apikey" || lower === "api_key" || lower === "authorization") {
        out[key] = REDACTED;
      } else if (lower === "password" || lower === "secret") {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  try {
    return redactString(String(value));
  } catch {
    return REDACTED;
  }
}

/** Shorthand for string payloads. */
export function redact(text: string): string {
  return redactString(text);
}
