/**
 * opencode plugin: Enhanced Prompt Cache & Session Management
 *
 * Features:
 * - Per-project cache isolation using absolute path with user@host prefix
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
 * 3. User@Host:Directory (auto-generated)
 * 4. Model headers (x-session-id / conversation_id / session_id)
 * 5. opencode sessionID (fallback)
 */

import { hostname, userInfo } from "os";
import { dirname, join } from "path";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const SESSION_HEADER_KEYS = ["x-session-id", "conversation_id", "session_id"];
const ENV_PROMPT_CACHE_KEY = "OPENCODE_PROMPT_CACHE_KEY";
const ENV_STICKY_SESSION_ID = "OPENCODE_STICKY_SESSION_ID";
const ENV_CACHE_DEBUG = "OPENCODE_CACHE_DEBUG";

// Get plugin directory (where this file is located)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, "enhanced-cache.log");

class DebugLogger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.debugEnabled = null;
    this.loggedInputStructure = false;
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    try {
      const logDir = dirname(this.logFilePath);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // Ignore errors, fallback will use console.
    }
  }

  isEnabled() {
    if (this.debugEnabled === null) {
      this.debugEnabled =
        process?.env?.[ENV_CACHE_DEBUG] === "1" ||
        process?.env?.[ENV_CACHE_DEBUG] === "true";
    }
    return this.debugEnabled;
  }

  toLogString(value) {
    if (typeof value !== "object" || value === null) {
      return String(value);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  log(...args) {
    if (!this.isEnabled()) return;

    const timestamp = new Date().toISOString();
    const pid = process.pid;
    const message = args.map((arg) => this.toLogString(arg)).join(" ");

    // Keep each log entry on a single physical line.
    const safeMessage = message.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    const logLine = `[${timestamp}] [pid:${pid}] [enhanced-cache] ${safeMessage}\n`;

    try {
      // O_APPEND keeps each append atomic on POSIX filesystems.
      appendFileSync(this.logFilePath, logLine, "utf8");
    } catch {
      // Fallback to stderr when file append fails.
      console.error(`[pid:${pid}] [enhanced-cache]`, ...args);
    }
  }

  logInputStructureOnce(input) {
    if (this.loggedInputStructure) return;
    this.loggedInputStructure = true;

    const safeInput = {
      hasProvider: !!input?.provider,
      providerKeys: input?.provider ? Object.keys(input.provider) : [],
      hasModel: !!input?.model,
      modelKeys: input?.model ? Object.keys(input.model) : [],
      hasSessionID: !!input?.sessionID,
    };
    this.log("Input structure:", safeInput);
  }
}

class CacheKeyResolver {
  constructor(logger) {
    this.logger = logger;
  }

  sha256(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }

  isSha256Hex(value) {
    if (typeof value !== "string") return false;
    const v = value.trim();
    if (v.length !== 64) return false;
    return /^[a-fA-F0-9]{64}$/.test(v);
  }

  getTrimmedEnv(name) {
    const value = process?.env?.[name];
    return typeof value === "string" ? value.trim() : "";
  }

  getUsername() {
    try {
      const ui = userInfo();
      if (ui && ui.username) {
        return ui.username;
      }
    } catch {
      // userInfo may fail in restricted environments.
    }

    return (
      process?.env?.USER ||
      process?.env?.USERNAME ||
      process?.env?.LOGNAME ||
      "unknown"
    );
  }

  getUserHostDirectoryKey() {
    try {
      const user = this.getUsername();
      const host = hostname();
      const cwd = process.cwd();
      return `${user}@${host}:${cwd}`;
    } catch {
      return null;
    }
  }

  getHeaderSessionValue(input) {
    const headers =
      input?.model?.headers && typeof input.model.headers === "object"
        ? input.model.headers
        : {};

    const value = SESSION_HEADER_KEYS.map((key) => headers[key])
      .find((v) => typeof v === "string" && v.trim())
      ?.trim?.();

    return value || null;
  }

  resolve(input) {
    let rawKey = null;
    let source = null;
    let alreadyHashed = false;

    // 1) Explicit env override.
    const promptCacheKey = this.getTrimmedEnv(ENV_PROMPT_CACHE_KEY);
    if (promptCacheKey) {
      rawKey = promptCacheKey;
      source = ENV_PROMPT_CACHE_KEY;
    }

    // 2) Secondary env override.
    if (!rawKey) {
      const stickySessionKey = this.getTrimmedEnv(ENV_STICKY_SESSION_ID);
      if (stickySessionKey) {
        rawKey = stickySessionKey;
        source = ENV_STICKY_SESSION_ID;
      }
    }

    // 3) Preferred stable default.
    if (!rawKey) {
      const userHostDirKey = this.getUserHostDirectoryKey();
      if (userHostDirKey) {
        rawKey = userHostDirKey;
        source = "user@host:directory";
      }
    }

    // 4) Existing model headers only when no stable default exists.
    if (!rawKey) {
      const headerValue = this.getHeaderSessionValue(input);
      if (headerValue) {
        rawKey = headerValue;
        source = "model headers";
        alreadyHashed = this.isSha256Hex(rawKey);
      }
    }

    // 5) OpenCode session fallback.
    if (!rawKey) {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
      if (sessionID) {
        rawKey = sessionID;
        source = "opencode sessionID";
      }
    }

    if (!rawKey) {
      this.logger.log("No stable cache key found");
      return null;
    }

    const hashedKey = alreadyHashed ? rawKey : this.sha256(rawKey);

    if (alreadyHashed) {
      this.logger.log("Cache key already looks hashed; skipping sha256");
    }

    this.logger.log(`Using cache key from ${source}`);
    this.logger.log(`  Raw: ${rawKey}`);
    this.logger.log(`  Hash: ${hashedKey}`);

    return { raw: rawKey, hashed: hashedKey };
  }
}

class CacheKeyApplier {
  constructor(logger) {
    this.logger = logger;
  }

  applyPromptCacheKey(output, cacheKey) {
    const existingOutputOptions =
      output?.options && typeof output.options === "object" ? output.options : {};

    output.options = {
      ...existingOutputOptions,
      promptCacheKey: cacheKey,
    };
  }

  applySessionHeaders(input, cacheKey) {
    if (input?.model && typeof input.model === "object") {
      const headers =
        input.model.headers && typeof input.model.headers === "object"
          ? input.model.headers
          : (input.model.headers = {});

      for (const headerKey of SESSION_HEADER_KEYS) {
        headers[headerKey] = cacheKey;
      }

      if (this.logger.isEnabled()) {
        headers["x-cache-debug"] = "1";
      }

      this.logger.log("Set final cache key (hashed):", cacheKey);
      return;
    }

    this.logger.log("Input model is missing or not an object, cannot set session headers");
  }

  apply(input, output, cacheKey) {
    this.applyPromptCacheKey(output, cacheKey);
    this.applySessionHeaders(input, cacheKey);
  }
}

class EnhancedCachePluginService {
  constructor({ logger, keyResolver, keyApplier }) {
    this.logger = logger;
    this.keyResolver = keyResolver;
    this.keyApplier = keyApplier;
  }

  initialize() {
    this.logger.log("Plugin initialized");
    this.logger.log("Log file location:", this.logger.logFilePath);
  }

  handleChatParams(input, output) {
    this.logger.logInputStructureOnce(input);
    this.logger.log("Processing provider");

    const cacheKeyInfo = this.keyResolver.resolve(input);
    if (!cacheKeyInfo) {
      this.logger.log("No cache key available");
      return;
    }

    this.keyApplier.apply(input, output, cacheKeyInfo.hashed);
  }
}

const logger = new DebugLogger(LOG_FILE);
const keyResolver = new CacheKeyResolver(logger);
const keyApplier = new CacheKeyApplier(logger);
const pluginService = new EnhancedCachePluginService({ logger, keyResolver, keyApplier });

export const EnhancedCachePlugin = async () => {
  pluginService.initialize();

  return {
    "chat.params": async (input, output) => {
      pluginService.handleChatParams(input, output);
    },
  };
};

export default EnhancedCachePlugin;
