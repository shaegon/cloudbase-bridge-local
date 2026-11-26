# aiProxy (vendored + hardened)

Vendored from [DaBinBinah/cloudbase-bridge](https://github.com/DaBinBinah/cloudbase-bridge)
at commit `67fc4da3` (aiProxy 1.3.0), MIT licensed. Local changes:

| Change | Why |
| --- | --- |
| `@cloudbase/node-sdk` pinned to `3.18.8` (exact) | Reproducible deploy; no floating `^3.16.0` range |
| `maxTokens` clamped to `MAX_OUTPUT_TOKENS` (16384) | Bounds an accidental/abusive generation bill |
| remote `http(s)` image URLs rejected unless `AI_PROXY_ALLOW_REMOTE_IMAGES=true` | Removes the "model provider fetches an arbitrary URL" primitive |
| `ping` no longer returns `TCB_ENV` | Avoids leaking the environment id to any allowed caller |
| removed `_callModelOverride` | Test-only hook with no place in production |
| `event.extra` forwards a validated allowlist of reasoning parameters (`reasoning_effort`, `thinking`, `enable_thinking`, `chat_template_kwargs`) | Lets a caller turn a thinking model's chain of thought off — without it, a request with a small `max_tokens` can come back with no visible text at all |

Everything else (validation, error envelopes, SDK wiring) is the reviewed
upstream code. See `../../SECURITY.md` for the review scope.

## Deploy

Console:

1. Create a normal **Event Function** named `aiProxy`, runtime Nodejs18.15+,
   memory 256 MB, **timeout 120 s**, entry `index.main`.
2. Upload `index.js` + `package.json`; enable **installDependency** (or ship
   `node_modules` yourself — do not do both).
3. Environment variables:
   - `AI_PROXY_ALLOWED_MODELS` — comma-separated allowlist (keep it minimal);
   - `AI_PROXY_ALLOW_REMOTE_IMAGES` — leave `false` unless you need remote
     image URLs (see the SSRF note below).
4. Invoke with `{"action":"ping"}` and expect `{"ok":true,"service":"aiProxy",...}`
   with no `env` field.

CLI:

```bash
cp cloudbaserc.example.json cloudbaserc.json   # set envId
tcb login
tcb fn deploy aiProxy --force
tcb fn invoke aiProxy --params '{"action":"ping"}'
```

## Lock the function down

The function itself has no caller authentication; the platform ACL is the gate.
Do all of the following:

- In **云函数 → aiProxy → 权限控制**, deny non-admin invocation (for example
  `{"invoke": false}`) unless a client app really needs to call it. If a client
  does, at minimum exclude anonymous users.
- In **环境 → 权限控制 / OPA 策略**, make sure HTTP API function invocation is
  allowed only for the identity your bridge API key uses. Unauthenticated HTTP
  API calls should remain denied (the platform default).
- Disable anonymous login if the environment does not need it.
- Keep `AI_PROXY_ALLOWED_MODELS` minimal and rotate the API key if it leaks.

The bridge's local gateway calls this function with a server-side API key, so
tightening the client-SDK rule does not break it.

## Why remote images are off by default

`image_url` with an `http(s)` URL is fetched by Tencent's model backend, not by
this function. Anyone who can invoke the function could therefore make the
provider request arbitrary URLs (blind SSRF / probing). The bridge's local
gateway also blocks remote URLs by default; this check protects direct callers
too. Prefer `data:image/...;base64,` URLs.

## License

MIT. The original copyright and license are those of
DaBinBinah/cloudbase-bridge; see the repository's LICENSE.
