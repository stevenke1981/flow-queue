# flow-queue-bridge — 讓 AI 代理操作 Flow Queue

這個資料夾是 Flow Queue 擴充功能的「本機橋接程式」，讓 Claude Code、OpenAI Codex CLI、Google Antigravity（agy）等 AI 代理，
透過 MCP 工具（或 `flowq` 指令）把提示詞加入佇列、開始／暫停、查看進度與結果。

- 純 Node.js，**零相依套件**（Node 18 以上；建議 22+）。
- 只監聽 `127.0.0.1:17345`（可用環境變數 `FLOW_QUEUE_PORT` 修改）。
- 擴充功能與橋接程式之間用**配對碼**雙向驗證（HMAC-SHA256），網頁無法冒用。

```
AI 代理 ──stdio──▶ mcp.js ──HTTP + Bearer token──▶ server.js（常駐） ◀──WebSocket（配對驗證）── Chrome 擴充功能
flowq（cli.js） ─────────────┘
```

| 檔案 | 用途 |
|---|---|
| `server.js` | 常駐程式：HTTP API（`/api/health`、`/api/call`）＋ 給擴充功能連線的 WebSocket（`/ext`） |
| `mcp.js` | MCP 伺服器（stdio）。啟動時若常駐程式沒在跑，會自動在背景啟動它 |
| `cli.js` | 指令列工具 `flowq` |
| `lib.js` | 共用程式（token、HTTP、啟動常駐程式、讀取圖片） |
| `test/smoke.js` | 自動測試：`node test/smoke.js` |

---

## 1. 第一次設定：配對

1. 在 Chrome 安裝（或重新載入）Flow Queue 擴充功能。
2. 在終端機取得配對碼（第一次執行時會自動產生，存放於 `~/.flow-queue/token`，Windows 為 `%USERPROFILE%\.flow-queue\token`）：

   ```powershell
   node G:/flow_extension/flow-queue-bridge/cli.js pair
   ```

3. 打開 Flow Queue 側邊面板 → 設定中的「AI 橋接」→ 貼上這串 64 個字元的配對碼，並**勾選啟用橋接**（預設為關閉）。
4. 啟動常駐程式（AI 代理呼叫 MCP 時也會自動啟動，這一步可省略）：

   ```powershell
   node G:/flow_extension/flow-queue-bridge/cli.js status
   ```

   側邊面板顯示「已連線」即完成。擴充功能每 30 秒會自動重試連線，常駐程式晚一點才啟動也沒關係。

> 配對碼等同密碼：任何拿到它的本機程式都能操作你的佇列。不要貼到網路上；若外流，刪除 `~/.flow-queue/token`、
> 結束常駐程式（工作管理員中的 `node … server.js`）後重新執行 `flowq pair`，再到側邊面板貼上新的配對碼。

（選擇性）安裝成全域指令：在此資料夾執行 `npm link`，之後就能直接用 `flowq` 與 `flow-queue-mcp`。
以下範例都用絕對路徑 `node G:/flow_extension/flow-queue-bridge/mcp.js`，不需要安裝。

---

## 2. 接上 AI 代理

### Claude Code

```powershell
claude mcp add flow-queue -- node G:/flow_extension/flow-queue-bridge/mcp.js
```

想讓所有專案都能用，加上 `--scope user`：`claude mcp add --scope user flow-queue -- node G:/flow_extension/flow-queue-bridge/mcp.js`。
在 Claude Code 中輸入 `/mcp` 可確認 `flow-queue` 已連線。

### OpenAI Codex CLI

編輯 `~/.codex/config.toml`（Windows：`%USERPROFILE%\.codex\config.toml`），加入：

```toml
[mcp_servers.flow-queue]
command = "node"
args = ["G:/flow_extension/flow-queue-bridge/mcp.js"]
# 選填：工具逾時（秒）。flow_wait 每次最多等約 45 秒就會回傳，預設值即可。
# tool_timeout_sec = 60
```

在 Codex 中輸入 `/mcp` 可查看已載入的伺服器。

### Google Antigravity CLI（`agy`）

依 Google 官方文件，Antigravity CLI 從兩個 JSON 檔讀取 MCP 伺服器設定，格式為頂層 `mcpServers` 物件，
本機 stdio 伺服器使用 `command`／`args`／`env` 欄位：

- 全域（所有專案）：`~/.gemini/config/mcp_config.json`（Windows：`%USERPROFILE%\.gemini\config\mcp_config.json`）
- 單一工作區：`<工作區>/.agents/mcp_config.json`

```json
{
  "mcpServers": {
    "flow-queue": {
      "command": "node",
      "args": ["G:/flow_extension/flow-queue-bridge/mcp.js"]
    }
  }
}
```

存檔後在 `agy` 中輸入 `/mcp` 開啟 MCP 管理介面，確認狀態或重新載入設定。注意事項：

- JSON 不能有註解。
- 較舊版本的 agy 使用 `~/.gemini/antigravity-cli/mcp_config.json`；若上面的路徑沒有作用，請改放這裡，或在 `/mcp` 介面查看實際讀取的檔案。
- 官方文件沒有記載 `agy mcp add` 指令（部分第三方教學有提到），以直接編輯 JSON 最可靠。
- 有使用者回報 agy 不會把外部環境變數傳給 MCP 伺服器；若要改埠號，請把 `"env": { "FLOW_QUEUE_PORT": "17345" }` 直接寫進設定。

資料來源（2026-11 查證）：
[Antigravity 官方 MCP 文件](https://antigravity.google/docs/mcp/)、
[DEV Community：Configuring MCP Servers and Skills for Antigravity CLI and IDE](https://dev.to/gde/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-2bh0)、
[Medium：Where does Antigravity look for MCP Servers?](https://medium.com/google-cloud/where-does-antigravity-look-for-mcp-servers-ed3727b4686c)、
[Arm Learning Paths：Antigravity CLI 安裝指南](https://learn.arm.com/install-guides/antigravity/)（舊路徑）。

### 其他支援 MCP 的工具

大多數工具（Claude Desktop、Cursor、Gemini CLI 等）都接受這種通用格式：

```json
{
  "mcpServers": {
    "flow-queue": { "command": "node", "args": ["G:/flow_extension/flow-queue-bridge/mcp.js"] }
  }
}
```

---

## 3. MCP 工具一覽

| 工具 | 說明 |
|---|---|
| `flow_status` | 執行狀態、各狀態數量、已開啟的 Flow 分頁、橋接狀態 |
| `flow_add_prompts` | 加入提示詞；每筆可附 `images`（本機路徑或公開的 http(s) 網址）、`characters`、`assets`；`start: true` 加入後立即開始 |
| `flow_list_queue` / `flow_get_item` | 列出佇列 / 查看單筆（含錯誤與結果） |
| `flow_start` / `flow_pause` / `flow_stop` | 開始、暫停、停止 |
| `flow_retry` / `flow_remove` / `flow_clear` | 重試、刪除、清除已完成或失敗 |
| `flow_settings` | 讀取或修改設定（`patch`） |
| `flow_logs` | 最近的紀錄 |
| `flow_list_assets` | 列出 Flow 專案中的素材／角色名稱 |
| `flow_wait` | 等待佇列完成。**每次呼叫最多約 45 秒就回傳**；若結果為 `done: false` 請再呼叫一次 |

圖片限制：每張 ≤ 10 MB、必須是圖片格式；網址只接受 http(s)，且會阻擋指向本機、區網、link-local 等私有位址的網址（含轉址）。
圖片會逐一上傳到擴充功能，再以參考的方式加入佇列。每次加入都附帶 `requestId`，重送時擴充功能不會重複加入。

範例指示（給 AI 代理）：「用 flow_add_prompts 把這 5 段提示詞加入 Flow Queue，每段都附上角色 Hero 和 D:/refs/castle.png，然後開始並等待完成，最後告訴我每段的結果。」

---

## 4. 指令列 `flowq`

```powershell
# 以下的 flowq 等同 node G:/flow_extension/flow-queue-bridge/cli.js（npm link 後可直接用 flowq）
flowq pair                                  # 顯示配對碼
flowq status
flowq add "a red fox in the snow" "a cat on the moon" --start
flowq add -f prompts.txt --split blank --character Hero --image D:/refs/a.png --top
flowq list --status failed,unknown
flowq get <id>
flowq retry                                 # 重試全部失敗／未確認／已停止
flowq remove <id> <id>
flowq clear done
flowq assets --category Characters --search hero
flowq logs --limit 20
flowq wait --timeout 3600                   # 等到沒有待處理／執行中的項目（逾時結束碼為 2）
flowq settings maxConcurrent=2 autoDownload=true
```

任何指令加上 `--json` 會輸出原始 JSON。

---

## 5. 安全設計

- 只綁定 `127.0.0.1`；HTTP 要求必須帶 `Authorization: Bearer <token>`（`/api/health` 除外）。
- 帶有 `Origin` 標頭的 HTTP 要求一律拒絕（擋掉網頁發出的要求）；`Host` 必須是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）。
- WebSocket `/ext` 只接受 Flow Queue 擴充功能的 Origin，連線後再以配對碼做雙向 HMAC 驗證：
  常駐程式驗證擴充功能（失敗以 4001 關閉），擴充功能也驗證常駐程式，驗證完成前不執行任何要求。
- HTTP 內容與 WebSocket 訊框上限 32 MB。

## 6. 疑難排解

| 狀況 | 處理方式 |
|---|---|
| 側邊面板顯示「尚未設定配對碼」 | 執行 `flowq pair`，貼上配對碼 |
| 「橋接程式拒絕配對碼」或「驗證失敗（配對碼不符）」 | 配對碼與 `~/.flow-queue/token` 不一致，重新執行 `flowq pair` 並貼上 |
| 「無法連線到橋接程式」 | 常駐程式沒在跑：執行 `flowq status`（會自動啟動）；或 `node server.js` 在前景執行查看訊息 |
| MCP 回傳 `extension is not connected` | Chrome 沒開、擴充功能沒有啟用橋接，或尚未配對 |
| 埠號 17345 被占用 | 設定環境變數 `FLOW_QUEUE_PORT`，並在側邊面板把橋接埠號改成相同數字 |

常駐程式的紀錄檔：`~/.flow-queue/daemon.log`（由 MCP／flowq 自動啟動時）。

## 7. 測試

```powershell
node G:/flow_extension/flow-queue-bridge/test/smoke.js
```

測試會在暫存資料夾產生 token、用隨機埠啟動常駐程式，並以模擬的 chrome API 實際載入 `../flow-queue/bridge-client.js` 當作擴充功能，
驗證健康檢查、401／403／503、雙向配對（錯誤配對碼 → 4001；常駐程式 welcome 驗證碼錯誤 → 擴充功能拒絕）、
API 往返、CLI，以及完整的 MCP stdio 工作階段。
