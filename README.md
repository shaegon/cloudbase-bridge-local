# cloudbase-bridge-local

把腾讯云开发（CloudBase）成长计划的 AI 模型变成**本机 OpenAI 兼容网关**。CloudBase 的服务端 API Key 只存在于这个守护进程里，不进入 Magpie，也不进入任何 Magpie 插件进程。

> 这是本地自用项目，不是 Magpie 插件。协议实现参考了
> [DaBinBinah/cloudbase-bridge](https://github.com/DaBinBinah/cloudbase-bridge)
> （MIT），云函数 `aiProxy` 直接固化自该仓库的已审版本并做了加固，详见
> [NOTICE](NOTICE) 与 [cloudfunctions/aiProxy/README.md](cloudfunctions/aiProxy/README.md)。

## 为什么不做成插件

Magpie 插件与 Magpie 主进程、其他插件跑在同一个用户进程里。插件通过 `getAuth()` 拿到的 CloudBase Key 是**环境管理员权限**；一旦某个插件被投毒，或者你更新了第三方插件，Key 就可能被静默带走。

本方案把 Key 移出 Magpie：

| | 第三方 Magpie 插件 | 本方案 |
| --- | --- | --- |
| Key 存放 | Magpie auth store + 进程内存 | 独立守护进程 / 600 文件 |
| 恶意插件能拿到 Key 吗 | 能 | 不能（只拿到本地随机 token） |
| 自动更新 | 有 | 无，代码是本地文件 |
| 配置把 Key 发错地址 | `gatewayBaseUrl` 可覆盖 | 设计上不存在该选项 |
| 需要审计的代码 | ~1100 行 + 构建产物 | 本仓库 ~700 行零依赖 |

**边界**：同一 Unix 用户下的进程仍可能读到 Key 文件或进程内存；本方案把“Key 失窃 → 环境接管”降级为“额度被用”。需要硬隔离见 [可选：硬隔离](#可选硬隔离)。

## 架构

```
Magpie / OpenCode / 任意 OpenAI 客户端
        │  http://127.0.0.1:8788/v1   (Bearer: 本地随机 token)
        ▼
cloudbase-bridge-local 守护进程（本机 127.0.0.1，持有 CloudBase API Key）
        │  https://{envId}.api.tcloudbasegateway.com/v1/functions/aiProxy
        ▼
aiProxy 云函数（你的环境，无 Key，用环境身份调用 SDK）
        ▼
腾讯云开发 AI 模型
```

## 快速开始

前置：Node.js >= 20；一个 CloudBase 环境（成长计划或 Token 包）；一个**服务端** API Key。

### 1. 部署并锁住 aiProxy

按 [cloudfunctions/aiProxy/README.md](cloudfunctions/aiProxy/README.md) 部署。要点：

- 函数类型：事件函数，运行时 Nodejs18.15+，超时 120 s；
- 依赖：`installDependency: true`，SDK 固定为 `3.18.8`；
- 环境变量：`AI_PROXY_ALLOWED_MODELS` 只保留你要用的模型；`AI_PROXY_ALLOW_REMOTE_IMAGES=false`；
- **权限**：云函数 → aiProxy → 权限控制，禁止非管理员调用；确认 OPA 策略只允许你的管理端 Key 身份走 HTTP API；不需要客户端就关掉匿名登录。

### 2. 生成本地配置

```bash
cd ~/Research/Scratch/cloudbase-bridge-local
node bin/cloudbase-bridge.mjs init --env-id cloud1-xxxxxxxxxxxx
```

它会创建：

- `~/.config/cloudbase-bridge/config.json`（600，含本地随机 token、envId、模型列表）；
- 打印本地 token —— 这是给 Magpie 用的，不是 CloudBase Key。

### 3. 写入 CloudBase API Key

Key 单独存一个 600 文件，不要写进 `config.json`：

```bash
umask 077
printf '%s' '你的 CloudBase 服务端 API Key' > ~/.config/cloudbase-bridge/api-key
chmod 600 ~/.config/cloudbase-bridge/api-key
```

也可以改用环境变量 `CLOUDBASE_API_KEY`（优先级高于文件）。

### 4. 启动并自测

```bash
node bin/cloudbase-bridge.mjs serve
```

另开一个终端：

```bash
TOKEN=$(jq -r .localToken ~/.config/cloudbase-bridge/config.json)
curl -s http://127.0.0.1:8788/v1/models -H "authorization: Bearer $TOKEN" | jq .
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"hy4","messages":[{"role":"user","content":"你好"}]}' | jq .
```

### 5. 接入 Magpie

在 Magpie 的“供应商 → 添加供应商 → API Key / 自定义兼容地址”里：

| 字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | `config.json` 里的 `localToken` |
| 模型 | `hy4`、`hy4-flash`、`hy3`、`deepseek-v4.1-flash` 等 |

Magpie 会把模型显示成 `<provider>/hy4`；网关会剥掉任意 `<provider>/` 前缀，只要后半段在 allowlist 里。

任何 OpenAI 兼容客户端也可以直接用：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8788/v1
export OPENAI_API_KEY=$(jq -r .localToken ~/.config/cloudbase-bridge/config.json)
```

### 6. 常驻（systemd user）

```bash
mkdir -p ~/.config/systemd/user
cp systemd/cloudbase-bridge.service ~/.config/systemd/user/
# 如果 node 或仓库路径不同，编辑 ExecStart
systemctl --user daemon-reload
systemctl --user enable --now cloudbase-bridge
journalctl --user -u cloudbase-bridge -f
```

> 该 unit 默认启用本机可用的 systemd 沙箱选项。`ProtectKernelModules=yes` 与
> `ProtectClock=yes` 在受限容器中会以 `status=218/CAPABILITIES` 启动失败，因此没有写入；
> 如果你的 user manager 支持，可以自行加回。`enable` 只保证登录后自启；若需要开机即启动
> （无需登录），再执行 `loginctl enable-linger "$USER"`。

## 安全设计

- **只监听回环**：`127.0.0.1`，没有监听地址配置项。
- **本地 token 鉴权**：所有 `/v1/*` 请求必须带 `Authorization: Bearer <localToken>`，用 SHA-256 + `timingSafeEqual` 比较。
- **Key 发送面唯一**：Key 只在 [src/upstream.mjs](src/upstream.mjs) 里作为 `Authorization` 头发往 `https://{envId}.api.tcloudbasegateway.com/v1/functions/{name}`；不存在 base URL 覆盖。
- **配置文件权限**：config 与 api-key 必须是 600、属于当前用户，否则拒绝启动。
- **不记录内容**：日志只有模型、耗时、token 数、字节数；日志器还会丢弃名字里带 key/token/authorization 的字段。
- **请求上限**：body 7 MiB、CloudBase 事件 6 MiB、`max_tokens` 上限 16384、并发上限 4（可配）。
- **默认禁止远程图片**：`image_url` 只接受 `data:image/...;base64`，避免模型提供方替你请求任意 URL；确需远程图片再开 `allowRemoteImages`。
- **推理参数按白名单放行**：只有 `reasoning_effort`、`thinking`、`enable_thinking`、`chat_template_kwargs` 四个名字在形状校验通过后进入云函数事件，其余字段一律丢弃（`reasoning_effort` 的取值会先按别名映射到云函数支持的档位，无法映射的档位丢弃并记一条 `extra_param_dropped` 警告，而不是让请求失败）；配置里的 `extraParams` 按模型附加，并可用 `when.maxTokensAtMost` 限定只对预算很小的请求生效。
- **云函数纵深防御**：同样的远程图片限制在函数里再做一次；`ping` 不再返回环境 ID；SDK 固定精确版本。
- **零运行时依赖**：没有 npm 依赖，没有安装脚本，没有 `dist/` 构建产物。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `envId` | — | CloudBase 环境 ID |
| `functionName` | `aiProxy` | 云函数名 |
| `region` | `cn` | `cn` / `intl` |
| `port` | `8788` | 本地端口，仅绑定 127.0.0.1 |
| `localToken` | init 生成 | 给 Magpie 的本地 token（≥32 字符） |
| `apiKeyFile` | 配置目录下 `api-key` | CloudBase Key 文件，必须 600 |
| `models` | 内置 6 个 | 允许的模型 allowlist |
| `maxOutputTokens` | `16384` | 请求里的 max_tokens 会被截断到此值 |
| `allowRemoteImages` | `false` | 是否允许 http(s) 图片 URL（SSRF 面） |
| `extraParams` | `{}` | 按模型附加的推理参数。直接写参数即无条件生效（`{"hy4":{"thinking":{"type":"disabled"}}}`）；写成 `{"when":{"maxTokensAtMost":N},"params":{…}}` 则只在该请求的输出预算 ≤ N 时生效——预算小到装不下「思维链 + 正文」时才关掉思考，正常长预算的对话不受影响 |
| `maxConcurrent` | `4` | 本地并发上限，超出返回 429 |
| `upstreamTimeoutMs` | `150000` | 单次云函数调用超时 |

配置示例见 [config.example.json](config.example.json)；不要直接使用里面的 token。

## 运维

**轮换 CloudBase Key**

```bash
printf '%s' '新 Key' > ~/.config/cloudbase-bridge/api-key   # umask 077
chmod 600 ~/.config/cloudbase-bridge/api-key
systemctl --user restart cloudbase-bridge
```

**轮换本地 token**：改 `config.json` 的 `localToken` → 重启守护进程 → 更新 Magpie 里的供应商 Key。

**日志**：`journalctl --user -u cloudbase-bridge`。正常日志类似：

```json
{"ts":"...","level":"info","msg":"chat_ok","model":"hy4","stream":false,"ms":3210,"tokens":42}
```

**升级**：本仓库没有自动更新。修改 `src/` 或云函数后自己审 diff；云函数升级后记得 `tcb fn deploy aiProxy --force`。

## 可选：硬隔离

如果威胁模型包含“同用户下的其他程序会翻文件”，可以再加一层：

1. 用独立系统用户运行守护进程（例如 `cloudbase-bridge`），Key 文件放在 `/var/lib/cloudbase-bridge/api-key`，属主为该用户、600；用 systemd system unit 启动。你的桌面用户读不到 Key。
2. Key 交给 systemd credentials（`LoadCredential` / `systemd-creds`），不落普通文件。
3. Magpie 仍只需要本地 token；它无法读守护进程的凭据。

这些是可选加固，不改变 Magpie 侧的配置方式。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `401 invalid_token` | Magpie 里的 Key 与 `config.json` 的 `localToken` 不一致 |
| `401 PERMISSION_DENIED` | CloudBase Key 错误/过期/不是服务端 Key |
| `403 EXCEED_AUTHORITY` | OPA 策略或函数权限拒绝了该身份 |
| `404 FUNCTIONS_NOT_FOUND` | 函数没部署、环境 ID 或函数名不对 |
| `404 model_not_found` | 模型不在 `models` allowlist |
| `429 concurrency_limit` | 本地并发打满，调大 `maxConcurrent` 或稍后重试 |
| `429 EXCEED_TOKEN_QUOTA_LIMIT` | CloudBase 额度用尽 |
| `429 upstream_rate_limited` | 模型调用被 CloudBase 限流（函数返回裸 `"429"`）。以前会被报成 502、客户端立刻重试而越限越狠；现在按 429 透传，客户端应退避 |
| `504 invoke_timeout` | 云函数超过 `upstreamTimeoutMs`，或函数超时没设成 120 s |
| `400 remote_image_not_allowed` | 默认禁用远程图片；改用 data URL 或显式开启 `allowRemoteImages` |
| 启动报 `EADDRINUSE` | 端口被占用，改 `port` |
| 启动报 `chmod 600` | 配置文件或 Key 文件权限过宽 |

## 测试

```bash
npm test
```

71 个测试，覆盖配置/权限、请求校验、推理参数白名单与预算守卫、SSE、并发、错误映射、超时、密钥不入日志、云函数加固点。测试不访问网络。

## 目录

```
bin/cloudbase-bridge.mjs    CLI（init / serve）
src/config.mjs              配置、权限校验、Key 读取
src/openai.mjs              Chat Completions 校验与响应/SSE
src/upstream.mjs            CloudBase 函数调用与错误映射
src/server.mjs              回环 HTTP 服务、鉴权、并发
cloudfunctions/aiProxy/     固化并加固的云函数
systemd/                    user service 示例
test/                       单元测试
```

## 许可

MIT。`cloudfunctions/aiProxy/index.js` 固化自 DaBinBinah/cloudbase-bridge（MIT），修改点在文件头与 [NOTICE](NOTICE) 中注明。
