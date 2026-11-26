# Security notes

## 目标

让 **CloudBase 环境管理员 API Key** 不进入 Magpie、OpenCode、agent 或第三方插件的进程。它们只拿到一个本地随机 token，这个 token 只能调用本机回环上的网关，不能用于腾讯云 API。

## 威胁模型

| 攻击者/场景 | 能做到 | 不能做到 |
| --- | --- | --- |
| 被投毒的 Magpie 插件 / 被 prompt injection 的 agent | 读取 Magpie 配置里的本地 token；通过网关消耗 AI 额度；读取它本来就能看到的对话 | 从 Magpie 的 auth store / 进程里拿到 CloudBase Key |
| 能读你 home 目录的同用户进程 | 读 `~/.config/cloudbase-bridge/api-key` → 拿到 Key | 这是本方案的边界；见“硬隔离” |
| 同机其他 Unix 用户 | — | 读 600 文件、访问 127.0.0.1 端口 |
| 局域网/网络攻击者 | — | 访问回环端口；从 TLS 流量里拿 Key |
| 仓库投毒/自动更新 | — | 本方案不加载远程插件；代码变更只来自你本地文件 |
| 能调用 aiProxy 的云函数调用方 | 消耗额度、使用模型 | 拿到 API Key（函数里没有 Key） |

明确不在范围内：root、物理访问、CloudBase/腾讯云平台本身、Magpie 宿主自身漏洞、同用户恶意程序的内存读取。

## 保证与不保证

**保证**

- Key 只可能从 `src/upstream.mjs` 的 `Authorization` 头发出，目标 URL 由校验过的 `envId/functionName` 固定拼出，没有 base URL 覆盖选项。
- Key 不写入 config、不打印、不进入日志/错误响应；日志器会丢弃敏感字段名。
- config 与 Key 文件在 POSIX 上必须 600 且属于当前用户，否则拒绝启动。
- `/v1/*` 需要本地 token；token 比较使用 SHA-256 + `timingSafeEqual`。
- 服务只绑定 `127.0.0.1`。
- 远程图片默认关闭，避免把“任意 URL 抓取”能力交给模型提供方。

**不保证**

- 同一用户下的任意进程仍可读取 Key 文件和进程内存。需要硬边界时，用独立系统用户或 systemd credentials 运行守护进程。
- CloudBase Key 本身是环境管理员权限；一旦泄露，影响的是整个环境。应使用**独立环境**、最小模型 allowlist、及时轮换。
- 本地 token 泄露只导致额度被用，不导致 Key 泄露；但它仍值得轮换。
- 云函数的权限收敛依赖 CloudBase 控制台/OPA 配置，代码无法代替。

## 验证方法

```bash
# 1. 单元测试（不联网）
npm test

# 2. 只有 upstream 模块构造 Authorization 头
grep -rn "authorization" src/

# 3. 只监听回环
ss -ltnp | grep 8788

# 4. 文件权限
stat -c '%a %U %n' ~/.config/cloudbase-bridge/config.json ~/.config/cloudbase-bridge/api-key
# 期望 600 <你的用户名>

# 5. 日志里没有 Key/token（启动后调用一次，再查）
journalctl --user -u cloudbase-bridge --since "5 min ago"
```

云函数的来源与修改点：

```bash
diff -u <(curl -sSL https://raw.githubusercontent.com/DaBinBinah/cloudbase-bridge/67fc4da3/cloudfunctions/aiProxy/index.js) \
        cloudfunctions/aiProxy/index.js
```

差异应只有文件头记录的 5 处加固（版本号、maxTokens 上限、远程图片开关、ping 去 env、移除测试钩子）。

## 部署检查清单

- [ ] CloudBase 使用独立环境，不承载生产数据
- [ ] `aiProxy` 函数权限禁止非管理员调用
- [ ] OPA 策略只允许你的 Key 身份调用函数 HTTP API
- [ ] 不需要客户端时关闭匿名登录
- [ ] `AI_PROXY_ALLOWED_MODELS` 只留实际使用的模型
- [ ] `AI_PROXY_ALLOW_REMOTE_IMAGES=false`
- [ ] config / api-key 都是 600
- [ ] 守护进程只监听 127.0.0.1
- [ ] 定期轮换 Key，怀疑泄露立即轮换
- [ ] 不把 Key 写进 shell 历史、截图、仓库或聊天记录

## 已知限制

- 上游是一次性生成，SSE 由本地合成；首 token 延迟等于整段生成时间。
- 工具调用、图片输入、`reasoning_content` 依赖 `aiProxy 1.3.0-local.2`，旧函数会缺字段。
- 推理参数（`reasoning_effort` / `thinking` / `enable_thinking` / `chat_template_kwargs`）是请求里唯一被放行的“非标准”字段，且必须通过名字白名单与形状校验；其余字段仍一律丢弃。`extraParams` 让配置按模型附加这些参数（例如让 `hy4` 关闭思考），并可用 `when.maxTokensAtMost` 限定只对输出预算很小的请求生效（预算装不下思维链加正文时，否则推理模型会交出空正文）。
- 函数依赖 `@cloudbase/node-sdk@3.18.8` 及其传递依赖；升级时请审 diff 并重新部署。
- 该项目的代码由本地维护，没有第三方安全审计；欢迎自行逐行审阅（总量约 700 行）。
