# sousuo

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

DeepSeek Harness 官方桌面端的搜索 Provider。`web_search` / `web_fetch` 仍走 AnySearch HTTP API；本地用多把 API Key，遇到 HTTP 402 时立刻换下一把并重试同一请求。一次请求最多转一圈，然后失败。401 / 403 / 429 不换号。连不上 API 的 `TypeError: fetch failed` 会先按系统 DNS 再试一次，仍失败且目标无需环境代理时，才用公共 DNS/DoH 解析到的 IPv4 直连（SNI 仍是请求主机名），避免本机缓存到失效 GTM 节点时整次搜索直接失败。配置 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 时保留系统代理路径，绝不绕代理发送凭据；`NO_PROXY` 仅对能安全确认的常用规则启用直连，其他规则只会停用 fallback。

默认**不**向模型暴露 `anysearch_capabilities` / `anysearch_search` / `anysearch_batch_search`。Grok 等高推理模型看见这组工具后，容易先做能力发现、搜完只在思考里说「再搜一次」然后 `stop`，界面就像调用网络时自动停了。普通问题走 `web_search` 即可，后端已经是 sousuo。若确实需要垂直 tag，在 desktop patch 里给本插件加 `advancedTools: true`。

面向 **官方桌面**。不要把 Key 写进 patch、README、Git 或对话。

## 安装

1. 复制本仓库到 `$DSH_HOME/plugins/sousuo`（默认 `$DSH_HOME` 为 `~/.dsh`）。
2. 再复制一份到 `$DSH_HOME/profiles/desktop/node_modules/sousuo`（桌面端要从 profile 内加载，才能解析 DSH 的 `@deepseek-ai/*` 包）。
3. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: sousuo
      name: ./node_modules/sousuo/lib/index.js
      config:
        baseURL: https://api.anysearch.com
        # advancedTools: true   # 可选：重新暴露 anysearch_* 垂直搜索工具

- id: web
  config:
    searchProvider: sousuo
    fetchProvider: sousuo
```

`- id: web` 会整段替换 `web` 的 config。完全退出 DeepSeek Harness（macOS：⌘Q）再打开。

## Key 文件

只存在本机，不进 Git。路径：`$DSH_HOME/plugins/sousuo/keys`

```
# 一行一把，# 开头为注释
```

```bash
cp keys.example keys
chmod 600 keys
```

用编辑器把真实 Key 写进 `keys`，不要贴到聊天里。C0/C1 控制字符在 trim 前就被拒绝，错误仅报告行号、不回显 Key。当前序号记在同目录 `state.json`（同样不进 Git）。每次请求捕获独立的 current-first 候选槽位快照，最多遍历一轮，不会因并发切换而跳过或重复 Key。

状态通过同目录独占创建的 0600 临时文件、完整写入/fsync/close、原子 rename 更新；写入失败保留旧状态并报告错误。这不是跨进程锁，也不承诺断电持久性。

`state.json` 不存在时自动初始化。文件无法读取、JSON 损坏或序号格式错误时会明确报错并保留原文件，不会静默重置；请先检查、修复状态文件，再重试。

## 说明

- 仓库不含本机 patch、账号、Key 或 `state.json`
- 后端是 AnySearch；本插件只做 Provider 适配、402 轮换，以及搜完必须作答的系统提示
- `web_search` / `web_fetch` 由官方 `tool-web` 注册并控制开关；插件只提供 AnySearch provider，不会把关闭的 `web_fetch` 重新开启
- DNS 直连支持响应断流、取消和空响应；公共 UDP DNS 查询最多使用 2.5 秒，停止操作会取消查询
- 成功响应的正文断流进入同一 Key 重试和 IPv4 fallback；真正的 JSON 格式错误不重试。错误响应即使正文断流，也保留 HTTP 状态：402 换下一把 Key，401 / 403 / 429 不重试、不轮换，保留 `Retry-After`。连接、正文读取和 DNS fallback 共用当前 HTTP 请求的 55 秒时限，取消和超时优先停止后续尝试
- 502 / 503 / 504 重试前释放旧响应；取消或失败退出时也会释放仍持有的旧响应。最终返回的错误响应仍可读取正文
- 所有 API 响应在 JSON 解析前限制为 5,000,000 字节；系统 fetch 按解码后字节计数。IPv4 pinned 请求要求 `identity` 编码，服务器若仍返回 gzip/br 等编码则明确失败、不重试，错误 HTTP 状态仍保留
- 搜索最多保留 50 个来源，标题 1,000、摘要 2,000、URL 4,000 字符；仅接受无凭据的绝对 HTTP(S) URL，超长 URL 整条省略而不改写目的地。诊断字段最多 256 字符，错误消息最多 2,000 字符，并对本次候选 Key 与错误 cause 做脱敏
- 高级搜索、批量搜索和能力目录的 `maxRenderedContentChars`（默认 12,000）限制的是**全部模型正文**，包含通知、来源、内容、截断提示和 followthrough footer；批量五项共享同一预算。极小预算只显示截断标记，不产生残缺引用链接。原生 `web_search` 同样限制实际官方渲染后的整体输出为 12,000 字符
- 高级搜索和批量搜索会同时报告客户端 20 万字符正文上限、来源裁剪与整体渲染预算造成的截断；未请求正文时不会报告正文截断。能力目录裁剪也有明确 `truncated` 标记，保留的 tag/参数名不会截成其他标识
- 本地提取的 55 秒 HTTP 截止映射为官方 `WEB_FETCH_TIMEOUT`，响应超大映射为 `WEB_FETCH_TOO_LARGE`；取消仍为 `WEB_ABORTED`，不会伪装成正常空结果
- `advancedTools` 默认关闭；打开后才会注册 `anysearch_*` 工具
- 测试里的 `k1` / `k2` 是假值，不是真实凭据

## 开发

```bash
for file in lib/*.js lib/tools/*.js; do node --check "$file" || exit; done
node --test test/*.test.mjs
```

测试使用假 Key 和本机 HTTP/UDP/代理服务，覆盖并发候选轮换、控制字符与错误脱敏、写入/同步/rename 失败保留状态、代理与 NO_PROXY、旧响应/socket 释放、成功及错误状态正文断流、取消/时限、原始响应字节上限、危险 URL、`__proto__` 参数、搜索/批量/目录整体输出预算与真实截断标记，不请求真实 AnySearch API。修改后同步 desktop profile 中的加载副本，并完全退出 DeepSeek Harness（⌘Q）再打开。
