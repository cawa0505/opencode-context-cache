# opencode-context-cache

Enhanced prompt cache and sticky session management plugin for OpenCode.

This project provides an OpenCode plugin that generates a stable, privacy-preserving cache key and applies it consistently across providers by writing both:

- `output.options.promptCacheKey`
- model session headers (`x-session-id`, `conversation_id`, `session_id`)

Observed result from a real run: input cache hit rate improved from a near-zero baseline to `97.99%` (`164736 / 168112`).

## Installation

### Recommended: directory-based auto-loading

OpenCode automatically loads local plugins from:

- Project-level: `.opencode/plugins/`
- Global: `~/.config/opencode/plugins/`

Copy or symlink `plugins/opencode-context-cache.mjs` into one of those directories.

Example (project-level):

```bash
mkdir -p .opencode/plugins
cp plugins/opencode-context-cache.mjs .opencode/plugins/opencode-context-cache.mjs
```

Restart OpenCode after adding the plugin.

### Optional: explicit config loading

If you prefer explicit loading via config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./plugins/opencode-context-cache.mjs"
  ]
}
```

For global config, `./plugins/...` is resolved relative to `~/.config/opencode/`.

If the file is already inside an auto-loaded plugin directory, this explicit entry is usually unnecessary.

## Observed impact (example)

Before enabling this plugin, cache hits were near zero in repeated sessions.

After enabling the plugin, one observed run reported:

```json
{
  "input_tokens": 168112,
  "total_tokens": 173268,
  "output_tokens": 5156,
  "input_tokens_details": {
    "cached_tokens": 164736
  },
  "output_tokens_details": {
    "reasoning_tokens": 3698
  }
}
```

Derived metrics:

- Input cache hit rate: `164736 / 168112 = 97.99%`
- Uncached input tokens: `168112 - 164736 = 3376` (`2.01%`)
- Cached input tokens reused: `164736`

Interpretation:

- Most prompt input was served from cache after key stabilization.
- Compared with a near-zero-hit baseline, this indicates a major cache reuse improvement.
- Actual latency/cost gains depend on model/provider pricing and cache policy.

## Compatibility

- Runtime: OpenCode plugin system (`chat.params` hook)
- Provider support: provider-agnostic (works across all configured providers)
- Module format: ESM (`.mjs`)

## Exports

- Default export: `OpenCodeContextCachePlugin`

## Why this plugin exists

OpenCode sessions can lose cache efficiency when session identifiers vary between providers, environments, or runs. This plugin standardizes cache key generation with predictable precedence and sends only a SHA256 digest upstream.

## Features

- Per-project cache isolation using `user@host:<absolute_cwd>` by default
- Works with all providers (no provider-specific branching)
- Stable cache key precedence with environment overrides
- SHA256 hashing for privacy (raw key is not sent to server)
- Digest detection to avoid double-hashing existing SHA256 values
- Optional debug logging to a local log file

## OpenCode loading behavior

OpenCode can load this plugin in two ways:

1. **Automatic local plugin loading** (recommended)
   - Global: `~/.config/opencode/plugins/`
   - Project: `.opencode/plugins/`
2. **Explicit `plugin` entry** in `opencode.json` / `opencode.jsonc`

To avoid confusion and accidental duplicate execution, use one loading method per plugin.

## Repository layout

- `plugins/opencode-context-cache.mjs`: main plugin implementation

## Cache key precedence

The plugin resolves the raw cache key in this order:

1. `OPENCODE_PROMPT_CACHE_KEY`
2. `OPENCODE_STICKY_SESSION_ID`
3. Auto-generated `user@host:<absolute_cwd>`
4. Existing model headers (`x-session-id`, `conversation_id`, `session_id`)
5. OpenCode `sessionID`

Then it applies:

- SHA256 hashing for normal keys
- No re-hash if the selected key already looks like a SHA256 hex digest

Result:

- The server receives only the hashed value.
- Sticky routing headers and `promptCacheKey` stay aligned.

## How it works

The plugin registers the `chat.params` hook and:

1. Computes the stable cache key (raw -> hashed)
2. Sets `output.options.promptCacheKey = <hashed>`
3. Sets model headers to the same hashed value:
   - `x-session-id`
   - `conversation_id`
   - `session_id`
4. Adds `x-cache-debug: 1` when debug mode is enabled

This keeps routing and prompt cache identity aligned.

## Configuration

Environment variables:

- `OPENCODE_PROMPT_CACHE_KEY`: highest-priority manual cache key override
- `OPENCODE_STICKY_SESSION_ID`: secondary manual override
- `OPENCODE_CONTEXT_CACHE_DEBUG`: set to `1` or `true` to enable debug logging

Example shell setup:

```bash
export OPENCODE_CONTEXT_CACHE_DEBUG=1
# Optional override:
# export OPENCODE_PROMPT_CACHE_KEY="team-cache-key"
```

## Debug logging

When debug mode is enabled, logs are appended to:

- `context-cache.log` in the same directory as the plugin file

Log entries include timestamp, process ID, key source, and hashed output details.
The log prefix is `[context-cache]`.

## Verify plugin is active

Use this checklist:

1. Start or restart OpenCode.
2. Ensure `OPENCODE_CONTEXT_CACHE_DEBUG=1` is set.
3. Open the log file in your plugin directory.
4. Confirm entries like:
   - `Plugin initialized`
   - `Using cache key from ...`
   - `Set final cache key (hashed): ...`

If these lines appear, the plugin is loaded and processing requests.

## Troubleshooting

- No log file created:
  - Check file path and permissions for the plugin directory.
  - Confirm `OPENCODE_CONTEXT_CACHE_DEBUG` is `1` or `true`.
- Plugin not loading:
  - Verify filename and extension (`opencode-context-cache.mjs`).
  - Verify plugin location (`~/.config/opencode/plugins/` or `.opencode/plugins/`).
  - Restart OpenCode after changes.
- Unexpected cache key changes:
  - The default key includes absolute working directory.
  - Moving or renaming the project path changes the key.
  - Use `OPENCODE_PROMPT_CACHE_KEY` for a fixed identity.
- Potential duplicate execution:
  - Avoid enabling both auto-loading and explicit `plugin` entry for the same file.

## Security recommendations

- Do not commit API keys to `opencode.jsonc`; prefer environment variables.
- Treat override keys as shared identity controls and rotate them if needed.
- Consider adding plugin log files to `.gitignore` if logs may include operational metadata.

## Notes

- The default key uses absolute working directory, so moving a project path changes the key.
- Use an explicit override if you need stable cache identity across different paths.
- Sharing the same override key across projects intentionally merges cache/session identity.

## License

No license file is currently included in this repository.
