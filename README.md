# @jimmyyen/opencode-context-cache
 
OpenCode plugin for stable, privacy-preserving prompt cache key and sticky session management.
 
Forked from [JackDrogon/opencode-context-cache](https://github.com/JackDrogon/opencode-context-cache).
 
## Why
 
OpenCode sessions can lose cache efficiency when session identifiers vary between providers, environments, or runs. This plugin standardizes cache key generation with predictable precedence and sends only a SHA256 digest upstream, so the AI provider sees a stable cache identity.
 
Observed result from a real run: input cache hit rate improved from a near-zero baseline to **97.99%** (`164736 / 168112`).
 
## Install
 
```bash
npm install @jimmyyen/opencode-context-cache
```
 
## Usage
 
Add to your `opencode.jsonc` plugin array:
 
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@jimmyyen/opencode-context-cache"
  ]
}
```
 
That's it — listed = enabled, removed = disabled. No provider options needed. The plugin auto-registers on the `chat.params` hook at import time.
 
## Magic Context Compatibility
If `@cortexkit/magic-context` is active, this plugin automatically switches to "Cache Locker" mode. It only writes to `promptCacheKey` and lets Magic Context handle the `conversation_id`. This ensures the plugin doesn't fight with the framework's own session management.
 
## Cache key precedence
 
1. `OPENCODE_PROMPT_CACHE_KEY` env var
2. `OPENCODE_STICKY_SESSION_ID` env var
3. Auto-generated `user@host:<absolute_cwd>`
4. Existing model headers (`x-session-id`, `conversation_id`, `session_id`)
5. OpenCode `sessionID`
 
The key is SHA256-hashed before being sent to the server. Already-hashed values (64-char hex) are detected and passed through without re-hashing.
 
## Debug logging
 
```bash
export OPENCODE_CONTEXT_CACHE_DEBUG=1
```
 
Logs are written to the plugin's directory (e.g., `.../plugins/opencode-context-cache.log`) with timestamps, PID, and key resolution details.
 
## Exports
 
| Export | Type | Description |
|--------|------|-------------|
| `OpenCodeContextCachePlugin` (default) | async factory | Main plugin factory |
| `EnhancedCachePlugin` | alias | Backward-compatible alias |
 
## License
 
MIT. See `LICENSE`.

