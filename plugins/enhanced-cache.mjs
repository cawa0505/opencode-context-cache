/**
 * opencode plugin: Enhanced Prompt Cache & Session Management
 *
 * Features:
 * - Per-project cache isolation using directory name with user@host prefix
 * - Support for ALL providers (not just specific ones)
 * - Debug logging to file (same directory as plugin)
 * - Smart cache key generation with multiple fallbacks
 * - Unified session header and cache key management
 * - SHA256 hashed cache key for privacy (server sees only hash)
 *
 * Cache Key Format (raw): {user}@{host}:{directory}
 * Cache Key Format (sent to server): SHA256(raw)
 * Example: c@my-laptop:revm -> sha256:abc123...
 *
 * Cache Key Precedence:
 * 1. OPENCODE_PROMPT_CACHE_KEY env var (manual override)
 * 2. OPENCODE_STICKY_SESSION_ID env var (manual override)
 * 3. Model headers (x-session-id / conversation_id / session_id)
 * 4. User@Host:Directory (auto-generated)
 * 5. opencode sessionID (fallback)
 */

import { hostname, userInfo } from "os";
import { basename, dirname, join } from "path";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

// Get plugin directory (where this file is located)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, "enhanced-cache.log");

// Ensure log directory exists (though it should be same as plugin)
try {
  const logDir = dirname(LOG_FILE);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
} catch {
  // Ignore errors, we'll fall back if needed
}

// Get timestamp for log entries
const getTimestamp = () => {
  return new Date().toISOString();
};

// Debug logger - only logs when OPENCODE_CACHE_DEBUG is set
let debugEnabled = null;
let loggedInputStructure = false;
const isDebugEnabled = () => {
  if (debugEnabled === null) {
    debugEnabled =
      process?.env?.OPENCODE_CACHE_DEBUG === "1" ||
      process?.env?.OPENCODE_CACHE_DEBUG === "true";
  }
  return debugEnabled;
};

const debug = (...args) => {
  if (!isDebugEnabled()) return;

  const timestamp = getTimestamp();
  const pid = process.pid;
  const message = args
    .map((arg) => {
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");

  // 确保消息中没有换行符（防止一行被拆成多行）
  const safeMessage = message.replace(/\n/g, "\\n").replace(/\r/g, "\\r");

  // 完整的一行日志，最后确保只有一个换行符
  const logLine = `[${timestamp}] [pid:${pid}] [enhanced-cache] ${safeMessage}\n`;

  try {
    // 一次性写入完整的一行
    // 在 POSIX 系统上，O_APPEND 保证原子性
    appendFileSync(LOG_FILE, logLine, "utf8");
  } catch {
    // Fallback to console if file write fails
    console.error(`[pid:${pid}] [enhanced-cache]`, ...args);
  }
};

// SHA256 hash function
const sha256 = (input) => {
  return createHash("sha256").update(input, "utf8").digest("hex");
};

// Detect a sha256 hex digest (64 lowercase/uppercase hex chars).
// If we already have a digest, hashing again would cause cache-key drift.
const isSha256Hex = (value) => {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length !== 64) return false;
  return /^[a-fA-F0-9]{64}$/.test(v);
};

// Get username - try multiple methods
const getUsername = () => {
  try {
    const ui = userInfo();
    if (ui && ui.username) {
      return ui.username;
    }
  } catch {
    // userInfo might fail in some environments
  }

  // Fallback to environment variables
  return (
    process?.env?.USER ||
    process?.env?.USERNAME ||
    process?.env?.LOGNAME ||
    "unknown"
  );
};

// Get host@user:directory cache key
const getUserHostDirectoryKey = () => {
  try {
    const user = getUsername();
    const host = hostname();
    const cwd = process.cwd();
    // Use full absolute path to minimize collisions
    return `${user}@${host}:${cwd}`;
  } catch {
    return null;
  }
};

// Get or generate a stable cache key
const getStableCacheKey = (input) => {
  let rawKey = null;
  let source = null;
  let alreadyHashed = false;

  // 1. Check environment variables (highest priority)
  if (process?.env?.OPENCODE_PROMPT_CACHE_KEY) {
    const key = process.env.OPENCODE_PROMPT_CACHE_KEY.trim();
    if (key) {
      rawKey = key;
      source = "OPENCODE_PROMPT_CACHE_KEY";
    }
  }

  if (!rawKey && process?.env?.OPENCODE_STICKY_SESSION_ID) {
    const key = process.env.OPENCODE_STICKY_SESSION_ID.trim();
    if (key) {
      rawKey = key;
      source = "OPENCODE_STICKY_SESSION_ID";
    }
  }

  // 2. Try user@host:directory key (preferred default).
  // Keep this ahead of model headers so upstream/session headers can't accidentally
  // override our stable per-project cache key.
  if (!rawKey) {
    const userHostDirKey = getUserHostDirectoryKey();
    if (userHostDirKey) {
      rawKey = userHostDirKey;
      source = "user@host:directory";
    }
  }

  // 3. Check existing model headers (lower priority).
  // Treat headers as an override only when we don't have a stable default.
  if (!rawKey) {
    const headers =
      input?.model?.headers && typeof input.model.headers === "object"
        ? input.model.headers
        : {};
    const headerValue = [
      headers["x-session-id"],
      headers["conversation_id"],
      headers["session_id"],
    ]
      .find((v) => typeof v === "string" && v.trim())
      ?.trim?.();

    if (headerValue) {
      rawKey = headerValue;
      source = "model headers";
      // If a previous run already stored a sha256 digest in headers,
      // treat it as final and do not hash again.
      alreadyHashed = isSha256Hex(rawKey);
    }
  }

  // 4. Fallback to opencode sessionID
  if (!rawKey) {
    const sessionID =
      typeof input?.sessionID === "string" ? input.sessionID : "";
    if (sessionID) {
      rawKey = sessionID;
      source = "opencode sessionID";
    }
  }

  if (!rawKey) {
    debug("No stable cache key found");
    return null;
  }

  // Hash the key for privacy (unless it is already a sha256 digest).
  const hashedKey = alreadyHashed ? rawKey : sha256(rawKey);

  if (alreadyHashed) {
    debug(`Cache key already looks hashed; skipping sha256`);
  }

  debug(`Using cache key from ${source}`);
  debug(`  Raw: ${rawKey}`);
  debug(`  Hash: ${hashedKey}`);

  return { raw: rawKey, hashed: hashedKey };
};

// Check if input has provider info (for debugging)
const logInputStructure = (input) => {
  if (loggedInputStructure) return;
  loggedInputStructure = true;

  // Log the structure without sensitive data
  const safeInput = {
    hasProvider: !!input?.provider,
    providerKeys: input?.provider ? Object.keys(input.provider) : [],
    hasModel: !!input?.model,
    modelKeys: input?.model ? Object.keys(input.model) : [],
    hasSessionID: !!input?.sessionID,
  };
  debug("Input structure:", safeInput);
};

export const EnhancedCachePlugin = async () => {
  debug("Plugin initialized");
  debug("Log file location:", LOG_FILE);

  return {
    "chat.params": async (input, output) => {
      // Debug: log input structure once
      logInputStructure(input);

      // Process ALL providers, not just specific ones
      // (input.provider.info.npm doesn't exist in actual opencode structure)
      debug("Processing provider");

      const cacheKeyInfo = getStableCacheKey(input);
      if (!cacheKeyInfo) {
        debug("No cache key available");
        return;
      }

      const cacheKey = cacheKeyInfo.hashed;

      // Set promptCacheKey in output options (send hashed key to server)
      const existingOutputOptions =
        output?.options && typeof output.options === "object"
          ? output.options
          : {};
      output.options = {
        ...existingOutputOptions,
        promptCacheKey: cacheKey,
      };

      // Set session headers on input.model for sticky routing (send hashed key to server)
      if (input?.model && typeof input.model === "object") {
        const headers =
          input.model.headers && typeof input.model.headers === "object"
            ? input.model.headers
            : (input.model.headers = {});

        headers["x-session-id"] = cacheKey;
        headers["conversation_id"] = cacheKey;
        headers["session_id"] = cacheKey;

        // Add cache info header for debugging
        if (isDebugEnabled()) {
          headers["x-cache-debug"] = "1";
        }

        debug("Set final cache key (hashed):", cacheKey);
      } else {
        debug("Input model is missing or not an object, cannot set session headers");
      }
    },
  };
};

export default EnhancedCachePlugin;
