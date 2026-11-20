# flow-queue-bridge — 元件說明

Flow Queue 擴充功能的本機橋接程式：讓 AI 代理（Claude Code、Codex CLI、Antigravity `agy`…）透過 **MCP 工具**或 **`flowq` 指令**操作 Google Flow 佇列。
純 Node.js（18+，建議 22+），零相依套件；只監聽 `127.0.0.1:17345`（環境變數 `FLOW_QUEUE_PORT` 可改）。
代理的操作規則在 [agent-instructions.md](agent-instructions.md)（MCP `initialize` 會回傳它，`flowq agent-guide` 也會印出）。

```
AI 代理 ──stdio──▶ mcp.js ──HTTP + Bearer token──▶ server.js（常駐） ◀──WebSocket（配對碼雙向驗證）── Chrome 擴充功能
flowq（cli.js） ─────────────┘
```

| 檔案 | 用途 |
|---|---|
| `server.js` | 常駐程式：`GET /api/health`、`POST /api/call`，以及給擴充功能的 WebSocket `/ext` |
| `mcp.js` | MCP 伺服器（stdio，protocol 2025-06-18）；常駐程式沒在跑會自動在背景啟動 |
| `cli.js` | 指令列工具 `flowq` |
| `lib.js` | 共用：token、HTTP、啟動常駐程式、圖片讀取（SSRF 防護）、錯誤代碼、doctor、wait |
| `install.js` | `flowq install-mcp` 的實作 |
| `agent-instructions.md` | 給代理的操作規則（單一來源） |
| `test/smoke.js` | 自動測試：`node test/smoke.js` |

## 安裝與配對（人工步驟）

1. 安裝並啟用 Flow Queue 擴充功能。
2. 複製配對碼到剪貼簿（不會顯示在畫面上）：`node G:/flow_extension/flow-queue-bridge/cli.js pair --copy`
3. Flow Queue 側邊面板 →「設定」→「AI 代理橋接」：勾選「允許 AI 代理控制」，在「配對碼」貼上。
4. 註冊 MCP 伺服器（會先備份被修改的設定檔 `<檔案>.bak-<時間>`；可重複執行）：
   `node G:/flow_extension/flow-queue-bridge/cli.js install-mcp all`（先看會改什麼：加 `--dry-run`）
5. 檢查：`node G:/flow_extension/flow-queue-bridge/cli.js doctor --human`

配對碼存在 `~/.flow-queue/token`（Windows：`%USERPROFILE%\.flow-queue\token`），等同密碼，不要貼到聊天或網路上。
外流時：刪除該檔、結束 `node … server.js` 程序，再重新執行 `flowq pair --copy` 並貼上。
（選擇性）在此資料夾執行 `npm link`，即可直接使用 `flowq` 與 `flow-queue-mcp` 指令。

### install-mcp 會寫入的位置

| 目標 | 方式 |
|---|---|
| `claude` | 有 `claude` 指令時執行 `claude mcp add --scope user flow-queue -- <node> <mcp.js>`；找不到則略過並印出手動指令 |
| `codex` | `~/.codex/config.toml` 的 `[mcp_servers.flow-queue]`（只更新 command/args，保留你加的其他鍵；新建時加上 `tool_timeout_sec = 120`） |
| `agy` | `~/.gemini/config/mcp_config.json` 的 `mcpServers["flow-queue"]`；若舊版路徑 `~/.gemini/antigravity-cli/mcp_config.json` 存在也一併更新 |

指令與路徑都用絕對路徑（node 執行檔與 mcp.js）。Antigravity 的路徑依
[官方 MCP 文件](https://antigravity.google/docs/mcp/)（全域 `~/.gemini/config/mcp_config.json`、工作區 `.agents/mcp_config.json`，格式為 `mcpServers` 物件）；
舊路徑見 [Arm 安裝指南](https://learn.arm.com/install-guides/antigravity/)。在 agy 中輸入 `/mcp` 可查看狀態。

手動設定（不用 install-mcp 時）：

```
claude mcp add --scope user flow-queue -- node G:/flow_extension/flow-queue-bridge/mcp.js
```
```toml
# ~/.codex/config.toml
[mcp_servers.flow-queue]
command = "node"
args = ["G:/flow_extension/flow-queue-bridge/mcp.js"]
tool_timeout_sec = 120
```
```json
{ "mcpServers": { "flow-queue": { "command": "node", "args": ["G:/flow_extension/flow-queue-bridge/mcp.js"] } } }
```

## MCP 工具

| 工具 | 說明（花費） |
|---|---|
| `flow_doctor` | 依序檢查 daemon → extension → flow_tab → queue；回傳 `{ok, checks:[{name, ok, code?, detail, fix, fix_en}]}`（免費） |
| `flow_status` | 執行狀態、各狀態數量、Flow 分頁（免費） |
| `flow_add_prompts` | 加入提示詞（尚未生成）；`request_id` 防重複、超過上限需 `confirm`；回傳 `{added, ids, request_id}` |
| `flow_start` | 開始送出（**消耗點數**）；多個專案分頁時需 `tab_id`；回傳 `{tabId, title, url, projectId}` |
| `flow_wait` | 等待指定 `ids` 完成，每次 ≤ 45 秒；回傳 `done`、`stalled`（paused／idle_not_started／cooldown／stopped）等 |
| `flow_download` | 下載已完成項目，回傳絕對路徑（已下載過的會重用，`reused: true`） |
| `flow_retry` | 重試（**再次消耗點數**）；預設只重試 failed，「未確認」需指定 ids 並 `confirm_unknown: true` |
| `flow_list_queue`／`flow_get_item`／`flow_logs`／`flow_list_assets` | 查詢（免費） |
| `flow_pause`／`flow_stop`／`flow_remove`／`flow_clear`／`flow_settings` | 控制與管理 |

錯誤結果為 `isError: true`，並帶 `structuredContent: {code, error}`。

## 指令列 flowq

輸出到終端機時是文字，被管線／代理讀取時預設是 JSON；`--human`、`--json` 可強制。
結束碼：`0` 成功、`1` 錯誤（JSON：`{ok:false, code, error}`）、`2` 用法錯誤（`invalid_argument`）。

```
flowq doctor [--no-start]                      flowq pair --copy
flowq install-mcp [claude|codex|agy|all] [--dry-run]
flowq agent-guide                              flowq status
flowq add <prompt...> [-f file] [--split blank|line] [--image p] [--character n] [--asset n]
          [--request-id id] [--confirm] [--top] [--start]
flowq start [--tab id]     flowq pause     flowq stop
flowq list [--status s[,s]] [--limit n] [--offset n]     flowq get <id>
flowq retry [ids...] [--status s] [--confirm-unknown]    flowq remove <ids...>     flowq clear <done|failed|all>
flowq wait <ids...> | --all [--timeout 秒]     （未完成時結束碼 1，code 為 timeout 或 stalled）
flowq download <ids...> | --all-done [--no-wait]
flowq assets [--category c] [--search s] [--tab id]     flowq logs [--limit n]     flowq settings [key=value...]
```

`flowq pair` 不加 `--copy` 只會在終端機顯示配對碼；輸出被管線讀取時會拒絕（避免配對碼進入代理紀錄）。

## 錯誤代碼

| code | 意義 |
|---|---|
| `daemon_unreachable` | 連不到常駐程式（或它不接受目前的 token） |
| `extension_not_connected` | 擴充功能沒有連上（Chrome 沒開、未啟用、未配對） |
| `no_flow_tab` / `multiple_flow_tabs` | 沒有 Flow 專案分頁 / 有多個，需指定 tab_id |
| `confirm_required` | 一次加入超過上限（預設 20），需使用者同意後帶 confirm |
| `unknown_requires_confirm` | 「未確認」項目需使用者確認後才可重試 |
| `not_found` / `invalid_argument` | 找不到項目 / 參數錯誤 |
| `timeout` / `busy` / `extension_error` | 逾時 / 忙碌（冷卻等）/ 其他擴充功能錯誤 |

## 多個 Chrome 設定檔

一台電腦一個常駐程式；**同一時間只有一個設定檔能使用橋接**。後連上的設定檔會顯示「另一個 Chrome 設定檔正在使用橋接」，
約每分鐘檢查一次，原本的設定檔關閉後自動接手。在側邊面板按「改用這個設定檔」可立即接管；被接管的設定檔顯示「已被另一個 Chrome 設定檔接管」，
不會自動搶回，直到再按一次、修改橋接設定或重新啟動 Chrome（重新啟動後只會排隊等待）。
「忙碌／已被接管」通知都有配對碼簽章，複製過的設定檔資料夾（識別碼相同）會自動換新識別碼，不會互相踢來踢去。
`GET /api/health` 的 `instance` 是目前使用中設定檔識別碼的前 8 碼。想讓兩個設定檔各自被操作，請用不同埠號另開一個常駐程式。

## 安全設計

- 只綁定 `127.0.0.1`；`/api/call` 需 `Authorization: Bearer <token>`。
- 拒絕帶 `Origin` 標頭的 HTTP 要求；`Host` 必須是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）。
- WebSocket 只接受擴充功能的 Origin，並以配對碼做雙向 HMAC 驗證（錯誤 → 4001）；驗證前不執行任何要求。
- 圖片每張 ≤ 10 MB；網址只接受公開的 http(s)，阻擋本機／區網／link-local（含轉址與 DNS 解析結果）。HTTP 內容與 WebSocket 訊框上限 32 MB。

## 疑難排解

先執行 `flowq doctor --human`，照每個失敗項目的提示處理。常駐程式紀錄：`~/.flow-queue/daemon.log`。
埠號 17345 被占用時，設定 `FLOW_QUEUE_PORT` 並在側邊面板把「橋接埠」改成相同數字。

## 測試

`node G:/flow_extension/flow-queue-bridge/test/smoke.js` — 使用暫存的 HOME、隨機埠、模擬的 chrome API（實際載入 `../flow-queue/bridge-client.js`）
與假的 `claude` 指令，不會碰到你真正的設定檔；涵蓋 HTTP 安全檢查、配對、多設定檔、MCP 工作階段、CLI 與 install-mcp。
