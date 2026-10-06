# sousuo

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

DeepSeek Harness 官方桌面端的搜索 Provider。`web_search` / `web_fetch` 仍走 AnySearch HTTP API；本地用多把 API Key，遇到 HTTP 402 时立刻换下一把并重试同一请求。一次请求最多转一圈，然后失败。401 / 403 / 429 不换号。连不上 API 的 `TypeError: fetch failed` 会先按系统 DNS 再试一次，仍失败则用公共 DNS/DoH 解析到的 IPv4 直连（SNI 仍是 `api.anysearch.com`），避免本机缓存到失效 GTM 节点时整次搜索直接失败。

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

用编辑器把真实 Key 写进 `keys`，不要贴到聊天里。当前序号记在同目录 `state.json`（同样不进 Git）。

`state.json` 不存在时自动初始化。文件无法读取、JSON 损坏或序号格式错误时会明确报错并保留原文件，不会静默重置；请先检查、修复状态文件，再重试。

## 说明

- 仓库不含本机 patch、账号、Key 或 `state.json`
- 后端是 AnySearch；本插件只做 Provider 适配、402 轮换，以及搜完必须作答的系统提示
- `web_search` / `web_fetch` 由官方 `tool-web` 注册并控制开关；插件只提供 AnySearch provider，不会把关闭的 `web_fetch` 重新开启
- DNS 直连支持响应断流、取消和空响应；公共 UDP DNS 查询最多使用 2.5 秒，停止操作会取消查询
- 成功响应的正文断流进入同一 Key 重试和 IPv4 fallback；真正的 JSON 格式错误不重试。错误响应即使正文断流，也保留 HTTP 状态：402 换下一把 Key，401 / 403 / 429 不重试、不轮换，保留 `Retry-After`。连接、正文读取和 DNS fallback 共用当前 HTTP 请求的 55 秒时限，取消和超时优先停止后续尝试
- 502 / 503 / 504 重试前释放旧响应；取消或失败退出时也会释放仍持有的旧响应。最终返回的错误响应仍可读取正文
- 高级搜索和批量搜索会同时报告客户端 20 万字符内容上限与渲染上限造成的截断；未请求正文时不会报告正文截断
- `advancedTools` 默认关闭；打开后才会注册 `anysearch_*` 工具
- 测试里的 `k1` / `k2` 是假值，不是真实凭据

## 开发

```bash
for file in lib/*.js lib/tools/*.js; do node --check "$file" || exit; done
node --test test/*.test.mjs
```

测试使用假 Key 和本机 HTTP/UDP 服务，覆盖密钥轮换、损坏状态文件不被覆写、旧响应释放、成功及错误响应的正文断流、取消、空响应、DNS 时限与内容截断标记，不请求真实 AnySearch API。修改后同步 desktop profile 中的加载副本，并完全退出 DeepSeek Harness（⌘Q）再打开。
