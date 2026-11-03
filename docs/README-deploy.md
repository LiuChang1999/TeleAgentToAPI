# TeleAgent → OpenAI 兼容 API

把中国电信 TeleAgent 的模型能力，变成标准 OpenAI 接口，跑在 Linux 服务器上。

已在 `your-server`（Debian 13 / x86_64）验证通过。

## 为什么是这个架构

TeleAgent 的 Windows 客户端无法直接在 Linux 上跑，上游网关还有一层私有签名
（`X-SuperAgent-*` + AK/SK，密钥编译进内核、通过 stdin 下发，黑盒无法复刻）。

但**官方信创版（deb，amd64）自带 Linux 原生 Go 内核**。这个内核自己会签名，
所以我们只需要：

1. 在 Windows 上拿到登录态（token + 设备号）
2. 在 Linux 上把登录态喂给原生内核
3. 内核自己完成签名和续期，我们只负责把它的 HTTP API 翻译成 OpenAI

```
[Windows 偶尔开机]                    [Linux 常驻服务器]
collector/export.js                   launcher/launcher.js
  解密 token.json          ──►          构造 AUTH_STATE → 启动内核 (:18080)
  + device-meta.json                      │
                                          ├─ shim.js (:18787) → OpenAI API
                                          │
                                          └─ 内核 → agent.teleai.com.cn（签名由内核完成）
```

## 目录

```
teleagent-proxy/
├── bin/super-agent-code       # 从 deb 提取的 Linux 内核（46MB）
├── credential.json            # Windows 导出的登录态（600 权限）
├── provider.json              # 模型 provider 定义（含 baseURL/apiKey/headers）
├── data/
│   ├── runtime-auth.json      # launcher 生成：内核会话密钥（600 权限）
│   ├── xdg-*/                 # 内核运行数据（数据库、缓存、日志）
│   └── *.log
├── launcher/launcher.js       # 启动内核，注入环境
├── shim.js                    # OpenAI 兼容网关
└── verify.js                  # 链路自检
```

## 接口

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | 对话，支持 `stream: true` |
| `GET /healthz` | 健康检查（会顺带探测内核） |

模型：`chat-pro`（智能）、`chat-flagship`（旗舰）、`chat-flash`（极速）、
`chat-lite`（轻量）、`chat-nano`（轻速）。

```bash
curl http://your-server:18787/v1/chat/completions \
  -H 'Authorization: Bearer sk-ta-xxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"chat-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

所有 `/v1/*` 请求必须带 API Key，Key 在管理后台创建。

## 管理后台

浏览器打开 `http://your-server:18787/admin`。

首次启动会自动生成管理员密码和一把默认密钥，打印在服务启动日志里：

```bash
journalctl --user -u teleagent-proxy | grep -A4 '管理后台'
# 或直接看数据文件
cat ~/teleagent-proxy/data/admin.json
```

功能：

| 页面 | 内容 |
|---|---|
| 概览 | 内核状态与延迟、凭据剩余天数、今日请求量、积分余额、模型表 |
| 密钥与积分 | 创建/编辑/删除 Key，设置积分额度、查看消耗进度条 |
| 调用方式 | 自动带当前 Key 的 curl / Python / Node 示例，一键复制 |
| 用量日志 | 最近 500 条请求：模型、tokens、扣费、耗时、来源 IP、成功与否 |
| 设置 | 修改管理员密码、服务信息 |

### 积分规则

> **重要：这里的「额度」是网关自己的计数器，不是电信账号的真实积分余额。**
> TeleAgent 客户端不提供余额查询接口，真实余额请到
> [电信控制台](https://console.teleai.com.cn/accountInfo) 查看。

每次请求按 `tokens × 模型系数` 扣减本地额度：

| 模型 | 系数 |
|---|---|
| chat-flagship（旗舰） | × 1.0 |
| chat-pro（智能） | × 0.6 |
| chat-flash（极速） | × 0.4 |
| chat-lite（轻量） | × 0.2 |
| chat-nano（轻速） | × 0.1 |

额度用尽返回 `429 quota_exceeded`，Key 被停用返回 `403 key_disabled`，
无效 Key 返回 `401 invalid_api_key`。

## 多账号

「账号」页可以管理多个 TeleAgent 账号，并在它们之间切换。

- **导入**：在已登录的 Windows 上跑 `node collector/export.js`，把生成的 JSON 整体粘贴到「导入账号」。
- **切换**：点「切换到此」，内核会重启并换用该账号的登录态，耗时约 1-3 秒。
  切换期间请求返回 `503 account_switching`。
- **隔离**：每个账号使用独立的数据目录 `data/instances/<id>/`，会话数据库不会互相污染。
- **归属**：每条调用日志都记录账号名，概览页显示当前正在消耗的账号。

实现方式：`accounts.json` 保存所有账号，`active` 指向当前账号；
`launcher.js` 启动时读取 `active`，把对应 token 加密成 `SUPER_AGENT_AUTH_STATE` 注入内核。

### 暴露到公网

默认监听 `0.0.0.0:18787`，内网可直接访问。公网建议二选一：

```bash
# 方案一：cloudflare tunnel（自带 HTTPS，不需要开端口）
cloudflared tunnel --url http://127.0.0.1:18787

# 方案二：nginx 反代 + 证书
# 注意给 /admin 加 IP 白名单或 basic auth，管理面不要裸奔
```

管理密码建议改成 12 位以上随机串（后台「设置」页可改）。

## 服务管理

```bash
systemctl --user status  teleagent-kernel teleagent-proxy
systemctl --user restart teleagent-proxy
systemctl --user restart teleagent-kernel     # 换凭据后重启内核
journalctl --user -u teleagent-proxy -f
```

已设置 `loginctl enable-linger`，开机自启、无需登录。

## 凭据续期（重要）

token 是 **20 天**有效期的 JWT。到期前在 Windows 上重新采集一次：

```powershell
# Windows，TeleAgent 处于已登录状态
node collector/export.js credential.json
```

然后把 `credential.json` 覆盖到服务器并重启内核：

```bash
scp credential.json user@your-server:~/teleagent-proxy/
ssh user@your-server 'systemctl --user restart teleagent-kernel teleagent-proxy'
```

`export.js` 会打印剩余天数。到期前 3 天建议设个提醒。

## 已知限制

- **上下文成本偏高**：内核是 agent 语义，每次请求都会带完整的系统提示词
  （实测约 13.8K prompt tokens）。适合低频调用或对质量要求高的场景；
  如果只是普通对话，成本会比直连模型 API 高。
- **多轮对话**：shim 把 `messages` 压平成单段文本喂给内核，语义上等价于
  “把历史记录重新说一遍”，不是原生多轮。
- **工具调用**：`tool_calls` 未透出，返回的是纯文本。
- **并发**：每个请求创建一个新 session，高并发时内核压力较大，建议在
  nginx 层限流。
- **合规**：把消费级客户端的额度转成 API 使用，是否符合服务条款需要自行确认。

## 从零重建

1. 从官方 deb 提取内核：
   ```bash
   dpkg-deb -x TeleAgent-*.deb ./extract
   tar -xzf extract/opt/TeleAgent/resources/super-agent-code-linux-x64.tar.gz -C bin/
   ```
2. Windows 端 `node collector/export.js credential.json`
3. 从已登录的 Windows 客户端导出 provider 配置（见 `tools/dump-provider.md`）
4. 上传 `credential.json` / `provider.json` / `bin/super-agent-code` / `launcher/` / `shim.js`
5. 安装两个 systemd user service
