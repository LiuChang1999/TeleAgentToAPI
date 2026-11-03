# TeleAgentToAPI

把**中国电信 TeleAgent（星辰超级智能体）**的模型能力，转成标准 **OpenAI 兼容 API**，跑在 Linux 服务器上。

带管理后台：多账号切换、API Key、额度控制、用量日志、调用示例。

```bash
curl http://your-server:18787/v1/chat/completions \
  -H "Authorization: Bearer sk-ta-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 为什么需要它

TeleAgent 只有桌面客户端，没有开放 API。想在自己的后端、Cherry Studio、Cline、自研应用里用它的模型，就需要一层转换。

难点在上游鉴权：除了 Bearer token，还有一层 `X-SuperAgent-*` 私有签名，密钥编译在内核里、通过 stdin 下发，黑盒无法复刻。

**但官方信创版（deb，amd64）自带 Linux 原生 Go 内核**，这个内核自己会签名。所以本项目不逆向签名，而是：

1. 在 Windows 上导出登录态（token + 设备号）
2. 在 Linux 上把登录态喂给原生内核
3. 内核负责鉴权和续期，本项目只做协议转换

## 特性

- **OpenAI 兼容**：`/v1/models`、`/v1/chat/completions`，SSE 真流式
- **多账号**：导入多个账号，一键切换，日志按账号归属
- **密钥与额度**：每个 API Key 独立额度，按 `tokens × 模型系数` 扣减
- **管理后台**：`/admin` 单页应用，无外部依赖
- **零第三方依赖**：只用 Node 内置模块，不需要 `npm install`

## 性能实测

单请求，300 字输出：

| 模型 | 首字延迟 | 总耗时 | 推流速度 |
|---|---|---|---|
| chat-nano（轻速） | **1.1s** | 2.7s | 128 字/秒 |
| chat-lite（轻量） | 2.5s | 3.2s | 429 字/秒 |
| chat-pro（智能） | 6.0s | 13.9s | 47 字/秒 |

纯生成速度（差值法扣除固定开销）：chat-flash 33 tok/s、chat-pro 53 tok/s、chat-flagship 63 tok/s。

> `chat-lite` / `chat-nano` 走直连路径，快但上下文小；`chat-pro` / `chat-flagship` 走完整 agent 编排，慢但能力强。

## 快速开始

### 1. 从 deb 提取 Linux 内核

```bash
# 从官网下载信创版 deb（银河麒麟 / 统信 UOS，amd64）
dpkg-deb -x TeleAgent-*.deb ./extract
tar -xzf extract/opt/TeleAgent/resources/super-agent-code-linux-x64.tar.gz -C bin/
chmod +x bin/super-agent-code
```

### 2. 在 Windows 上导出登录态

TeleAgent 保持已登录状态，在本仓库目录执行：

```powershell
node collector/export.js credential.json
```

输出账号名、账号 ID、租户、设备号、有效期。文件含 token，**不要提交到仓库**。

### 3. 准备 provider 配置

保存为 `provider.json`：

```json
{
  "provider": {
    "NewApi": {
      "id": "new-api",
      "name": "预置模型",
      "options": {
        "baseURL": "https://agent.teleai.com.cn/superCowork/sapi/api/v1",
        "apiKey": "<客户端内置的 key>",
        "headers": { "X-Route-Target": "ops-gateway" },
        "useSuperAgentAuth": true
      },
      "models": {
        "chat-pro": { "id": "chat-pro", "name": "智能", "limit": { "context": 400000, "output": 65536 } }
      }
    }
  }
}
```

`apiKey` 与 `models` 可从已登录客户端的 `/config` 接口读取，方法见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 4. 启动

```bash
node launcher/launcher.js &   # 拉起内核（默认 18080）
node shim/server.js &         # OpenAI 网关（默认 18787）
```

首次启动会打印管理员密码和默认 API Key。浏览器打开 `http://<服务器IP>:18787/admin`。

## 目录结构

```
bin/super-agent-code    从 deb 提取的 Linux 内核（不提交）
credential.json         Windows 导出的登录态（不提交）
provider.json           模型 provider 定义（不提交）
data/                   运行数据：账号、密钥、日志（不提交）
  ├── accounts.json     多账号
  ├── admin.json        管理员密码、API Key、额度
  └── instances/<id>/   每个账号独立的内核数据目录
collector/export.js     Windows 侧凭据导出
launcher/launcher.js    内核启动器（多账号）
shim/server.js          OpenAI 网关 + 管理 API
shim/admin.html         管理后台单页
deploy/*.service        systemd user 单元
tools/                  验证与压测脚本
```

## 管理后台

| 页面 | 内容 |
|---|---|
| 概览 | 内核状态、当前消耗账号、凭据剩余天数、今日用量、额度余额 |
| 账号 | 多账号列表、切换、导入、改名；显示真实用户名 / 账号 ID / 租户 |
| 密钥与额度 | 创建 / 编辑 / 删除 Key，设置额度上限 |
| 调用方式 | 自动填充当前 Key 的 curl / Python / Node 示例 |
| 用量日志 | 最近 500 条：账号、模型、tokens、扣费、耗时、来源 IP |
| 设置 | 修改管理员密码 |

### 额度规则

按 `tokens × 模型系数` 扣减本地额度：旗舰 ×1.0、智能 ×0.6、极速 ×0.4、轻量 ×0.2、轻速 ×0.1。

> **这里的额度是网关自己的计数器，不是电信账号的真实积分余额。**
> TeleAgent 客户端不提供余额查询接口，真实余额请到电信控制台查看。

## 系统服务

```bash
cp deploy/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now teleagent-kernel teleagent-proxy
loginctl enable-linger $USER      # 开机自启，无需登录
```

## 凭据续期

token 是 **20 天**有效期的 JWT。到期前在 Windows 上重新导出，覆盖 `credential.json` 后重启内核：

```bash
systemctl --user restart teleagent-kernel
```

## 已知限制

- **上下文成本**：内核是 agent 语义，部分请求会带约 13.8K 系统提示词 tokens
- **多轮对话**：`messages` 被压平成单段文本，不是原生多轮
- **工具调用**：`tool_calls` 未透出，返回纯文本
- **并发**：每个请求新建 session，内核单实例串行处理，高并发需在 nginx 层排队
- **平台**：内核只有 linux-x64 与 win-x64，ARM 需自行解决

## 免责声明

本项目仅用于个人学习与协议互操作研究。使用前请确认符合 TeleAgent 的服务条款。
将消费级客户端额度转作 API 使用可能违反服务协议，风险自负。

## License

MIT
