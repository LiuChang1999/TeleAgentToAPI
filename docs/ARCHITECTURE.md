# 架构与协议说明

本文记录实现所依赖的关键机制，便于后续维护与版本升级时的兼容性排查。

## 整体链路

```
Windows（偶尔开机）                  Linux（常驻）
─────────────────                  ────────────────────────────────
TeleAgent 客户端                    launcher.js
  └ token.json (os_crypt v10)         ├ 读 accounts.json 的 active
       │                              ├ 构造 AUTH_STATE
       └ export.js ──credential.json──▶├ spawn 内核（stdin 注入 env）
                                      │
                                    内核 super-agent-code :18080
                                      ├ 自己完成 X-SuperAgent-* 签名
                                      └ 调用 agent.teleai.com.cn
                                            ▲
                                    shim.js :18787
                                      ├ /v1/* OpenAI 兼容
                                      └ /admin 管理后台
```

## 1. 内核启动协议

内核**不读进程环境变量**，而是从 stdin 读取：

```
[4 字节大端长度][UTF-8 JSON 环境对象]
```

依据：客户端主进程中 `nfe()` 的实现——

```js
const e = Buffer.from(JSON.stringify(env), "utf8");
const r = Buffer.alloc(4);
r.writeUInt32BE(e.length, 0);
Buffer.concat([r, e]);
```

写入后关闭 stdin，内核解析完环境即开始监听 `SERVER_PORT`。

### 必需的环境变量

| 变量 | 说明 |
|---|---|
| `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` | 缺任何一个内核直接 Fatal 退出 |
| `SERVER_PORT` | 实际监听端口（默认 8080，常被占用需改） |
| `SUPER_AGENT_SERVER_URL` | 内核自报地址，与 `SERVER_PORT` 一致 |
| `SUPER_AGENT_APP_DATA_DIR` / `_CONFIG_DIR` / `LOG_DIR` | 数据目录 |
| `SUPER_AGENT_LOCAL_SESSION_KEY` | 本地 API 签名密钥，43 字符 base64url |
| `SUPER_AGENT_OPENCODE_USERNAME` / `_PASSWORD` | 本地 API 的 basic auth |
| `SUPER_AGENT_AUTH_STATE` | 加密后的登录态，见下节 |
| `OPENCODE_CONFIG_CONTENT` | provider 与模型定义（JSON 字符串） |

`SUPER_AGENT_APP_VERSION`、`SUPER_AGENT_SANDBOX_EXECUTION_MODE=legacy` 等按需设置。

## 2. 登录态加密

客户端把 `{token, deviceId, installId}` 用本地会话密钥加密后下发：

```js
key = sha256(sessionKey)                    // 32 字节
iv  = random(12)
aes-256-gcm(key, iv, JSON.stringify(state))
→ { version:'v1', iv, tag, ciphertext }     // 三段均 base64url
```

整体再 `JSON.stringify` 后作为 `SUPER_AGENT_AUTH_STATE`。

因为 `sessionKey` 是自己生成的，本项目可以完全复刻这一步——**不需要 Windows 客户端的 DPAPI**，只需要明文 token。

## 3. 本地 API 签名

内核的 HTTP API（`/config`、`/session`、`/event` 等）要求 basic auth + 一组签名头：

```
Authorization: Basic base64("super-agent:<password>")
X-SA-Sign-Version: local-v1
X-SA-Timestamp: <毫秒时间戳>
X-SA-Nonce: <12 字节 hex>
X-SA-Signature: base64url(HMAC-SHA256(sessionKey, payload))
```

payload 是换行拼接：

```
local-v1\n<METHOD>\n<pathname+search>\n<timestamp>\n<nonce>
```

注意 `pathname+search` 必须与实际请求路径完全一致，否则签名不通过。

## 4. 上游鉴权

内核调用 `agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions` 时，除 `Authorization: Bearer <apiKey>` 外还带：

```
x-token: <tenant>:<jwt>
x-superagent-sign-version: v1
x-superagent-timestamp / -nonce / -signature
x-superagent-device-id / -install-id
x-route-target: ops-gateway
x-teleai-client-type: desktop
```

签名由内核内部的 `AKSKSigner.Sign` 完成，密钥编译在二进制里、经 stdin 下发，**无法从外部复刻**。这正是必须跑原生内核的原因。

## 5. 事件流（真流式）

`GET /event` 是一条全局 SSE，事件按 `sessionID` 归属。流式实现依赖两类事件：

```jsonc
// 标记 part 类型（text / reasoning / step-start / tool ...）
{"type":"message.part.updated","properties":{"part":{"id":"prt_xxx","type":"text"}}}

// 增量文本
{"type":"message.part.delta","properties":{
  "sessionID":"ses_xxx","partID":"prt_xxx","field":"text","delta":" user"
}}
```

实现要点：

- 维护 `partID → type` 映射，**只转发 `type === 'text'` 的 delta**，丢弃 `reasoning`（思考过程）
- 全局复用一条 `/event` 连接，按 sessionID 分发，避免每个请求新建 SSE
- 先挂监听再发消息，防止丢事件
- `POST /session/:id/message` 是阻塞的，其返回值用于拿最终 `usage`，与事件流并行

## 6. 导出 provider 配置

客户端已登录时，其内核 `/config` 返回完整配置。用本项目的方式读取：

```bash
# 从客户端主进程环境块取 sessionKey 与 password（同用户可读）
# 然后签名调用：
GET http://127.0.0.1:4397/config
```

返回 JSON 中 `provider.NewApi` 即所需定义（含 `apiKey`、`baseURL`、`headers`、`models`）。

## 版本兼容性

本项目依赖的是**客户端内部实现**，升级后可能失效。重点关注：

- `super-agent-code` 的启动协议（stdin 格式）
- `AUTH_STATE` 的加密结构
- `/event` 的事件类型名
- `provider.options.useSuperAgentAuth` 的语义

排查顺序：先看内核日志 `data/instances/<id>/xdg-data/log/`，再确认 `/health` 是否 200，最后核对签名头。
