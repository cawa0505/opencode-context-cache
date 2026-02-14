# opencode-context-cache

Enhanced prompt cache and sticky session management plugin for OpenCode.

This project provides an OpenCode plugin that generates a stable, privacy-preserving cache key and applies it consistently across providers by writing both:

- `output.options.promptCacheKey`
- model session headers (`x-session-id`, `conversation_id`, `session_id`)

Observed result from a real run: input cache hit rate improved from a near-zero baseline to `97.99%` (`164736 / 168112`).

## Community

- Discussions: https://github.com/JackDrogon/opencode-context-cache/discussions
- Issues: https://github.com/JackDrogon/opencode-context-cache/issues

## Installation

### Required: explicit config loading

In this repository's verified setup, the plugin only takes effect when it is listed in the
`plugin` field of `opencode.jsonc`. Copying the file into a plugins directory alone is not
enough in this environment.

1. Put plugin file in a stable local path (example: global plugin dir):

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/opencode-context-cache.mjs ~/.config/opencode/plugins/opencode-context-cache.mjs
```

2. Add plugin entry in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./plugins/opencode-context-cache.mjs"
  ]
}
```

For global config (`~/.config/opencode/opencode.jsonc`), `./plugins/...` is resolved
relative to `~/.config/opencode/`.

3. Restart OpenCode after editing config.

### Activation prerequisites (important)

This plugin only takes effect after OpenCode actually loads the plugin file.

Required method:

1. Add it explicitly in `opencode.jsonc` with the `plugin` field.

`setCacheKey` / model cache flags only control cache behavior. They do not load the plugin by themselves.

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
- The effect is often stronger behind AI API relay/gateway services, where unstable upstream session identifiers can otherwise reduce cache reuse.
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
- Especially effective with AI API relay/gateway setups that benefit from stable cache/session identity
- Optional debug logging to a local log file

## OpenCode loading behavior

For this project, use explicit `plugin` entry in `opencode.json` / `opencode.jsonc` as the
source of truth. Directory auto-loading behavior may vary by runtime/version, so do not rely
on file placement alone for activation.

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

OpenCode config flags (often required for expected cache behavior):

- `provider.<id>.options.setCacheKey: true`: ensures the provider layer forwards a cache key when this plugin sets `output.options.promptCacheKey`.
- `provider.<id>.models.<id>.options.cache`: if your provider/model exposes this flag and it is set to `false`, upstream prompt caching is effectively disabled.
- `provider.<id>.models.<id>.options.store`: this is separate from prompt caching; for example, `store: false` controls response storage and does not replace `setCacheKey`.

Minimal working `opencode.jsonc` example (required explicit plugin loading + cache flags):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./plugins/opencode-context-cache.mjs"
  ],
  "provider": {
    "openai": {
      "options": {
        "setCacheKey": true
      },
      "models": {
        "gpt-5-3-codex-high": {
          "options": {
            // "cache": false,
            // If your provider supports the cache flag, setting it to false
            // disables upstream prompt cache reuse.
            "store": false
          }
        }
      }
    }
  }
}
```

Do not omit the `plugin` field above in this setup.

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

1. Confirm `opencode.jsonc` contains `"plugin": ["./plugins/opencode-context-cache.mjs"]`
   (or the equivalent valid path in your setup).
2. Start or restart OpenCode.
3. Ensure `OPENCODE_CONTEXT_CACHE_DEBUG=1` is set.
4. Open the log file in your plugin directory.
5. Confirm entries like:
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
  - Verify `opencode.jsonc` includes a valid `plugin` entry for this file.
  - Verify the `plugin` path is resolved relative to the config file location.
  - Restart OpenCode after changes.
- Unexpected cache key changes:
  - The default key includes absolute working directory.
  - Moving or renaming the project path changes the key.
  - Use `OPENCODE_PROMPT_CACHE_KEY` for a fixed identity.
- Potential duplicate execution:
  - If your runtime also auto-loads plugin directories, avoid loading the same file twice.

## Security recommendations

- Do not commit API keys to `opencode.jsonc`; prefer environment variables.
- Treat override keys as shared identity controls and rotate them if needed.
- Consider adding plugin log files to `.gitignore` if logs may include operational metadata.

## Notes

- The default key uses absolute working directory, so moving a project path changes the key.
- Use an explicit override if you need stable cache identity across different paths.
- Sharing the same override key across projects intentionally merges cache/session identity.

## License

MIT. See `LICENSE`.
