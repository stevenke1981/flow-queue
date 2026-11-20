# Flow Queue

把一大批提示詞（可以附角色、素材、參考圖）自動排進 **Google Flow** 生成，等結果出來，再幫你下載。

**主要的用法是交給 AI 代理**（Claude Code、OpenAI Codex、Google Antigravity `agy`）：你只要用一句話說想做什麼，代理會排隊、開始、等待、下載，並回報結果。你也可以自己在 Chrome 側邊面板手動操作。

> ⚠️ 每一次生成都會扣你 Flow 帳號的點數。代理一次要加入超過 20 筆時，會先問你。

- 不需要登入任何服務：直接使用你 Chrome 裡已經登入 Flow 的 Google 帳號。
- 所有東西都在你的電腦上執行：橋接程式只聽本機 `127.0.0.1`，而且要配對碼才能連線。

---

## 1. 最快的開始方式：叫你的代理幫你裝

在 Claude Code、Codex 或 agy 裡貼上這句話：

```text
請幫我安裝並設定 Flow Queue：https://github.com/stevenke1981/flow-queue ，照 repo 裡 AGENTS.md 的「First-time setup」步驟做，需要我動手的地方一次告訴我一步。
```

代理會下載 repo、把 Flow Queue 的工具登記到它自己身上，然後逐步請你完成下面「只有你能做的事」。

### 只有你能做的事

1. **安裝擴充功能**
   1. 開 `chrome://extensions`，打開右上角的「開發人員模式」。
   2. 按「載入未封裝項目」，選擇 repo 裡的 `flow-queue` 資料夾。
   3. 要在哪個 Chrome 設定檔使用，就在那個設定檔裡載入。
2. **配對**
   1. 在終端機執行 `node flow-queue-bridge/cli.js pair --copy`。配對碼會直接複製到剪貼簿，不會顯示在畫面上。
   2. 打開 Flow Queue 側邊面板，到「設定 → AI 代理橋接」。
   3. 貼上配對碼，再打開「允許 AI 代理控制」。
3. **開啟 Flow**
   1. 在 Chrome 開啟 [Google Flow](https://labs.google/fx/tools/flow)，登入並打開一個專案。
   2. 在 Flow 介面裡先選好模型、比例、每次輸出張數。佇列會沿用這些設定。

完成後跟代理說「檢查一下 Flow Queue」，它會執行 `flow_doctor`，確認每一個環節都正常。

### 也可以自己登記到代理

```bash
git clone https://github.com/stevenke1981/flow-queue.git
cd flow-queue
node flow-queue-bridge/cli.js install-mcp all      # 或 claude / codex / agy；先加 --dry-run 看看會改什麼
```

`install-mcp` 可以重複執行。它修改設定檔之前，會先備份一份 `*.bak-時間`。

## 2. 可以這樣跟代理說

- 「把 `prompts.txt` 裡的提示詞排進 Flow，每筆都用角色『小明』，跑完把圖下載下來給我路徑。」
- 「用 `ref/` 資料夾裡的三張圖當參考圖，幫這 10 個提示詞各生成一次。」
- 「佇列現在進度如何？失敗的是哪幾筆、原因是什麼？」
- 「失敗的重試一次；未確認的先不要動。」
- 「列出這個 Flow 專案裡有哪些角色。」

## 3. 代理會先問你的事

代理在下面這些情況會停下來問你，這是故意設計的：

- **一次加入超過 20 筆提示詞時。** 你同意後它才會送出。
- **要重試「未確認」的項目時。** 這些項目可能已經生成並扣過點數了，請你先到 Flow 看一下。
- **同時開著多個 Flow 專案分頁時。** 它會問你要用哪一個。
- **需要你動手的設定步驟。**

代理不會讀取或顯示你的配對碼，也不會修改橋接設定。

## 4. 自己用側邊面板操作

點擊工具列上的 Flow Queue 圖示，或按 `Alt+Shift+Q`。在面板裡：

1. 貼上提示詞，用空行分隔，或選擇「每行一個」。
2. 需要時在「素材」區附加角色、Flow 素材庫的素材或參考圖。
3. 按「加入佇列」，再按「開始」。

面板上可以看進度、縮圖、失敗原因，也可以重試或下載。詳細說明見 [`flow-queue/README.md`](flow-queue/README.md)。

## 5. 遇到問題

先跟代理說「執行 flow_doctor」。它會逐項檢查，並告訴你下一步該怎麼做。常見狀況：

| 狀況 | 怎麼辦 |
|---|---|
| 代理說擴充功能沒連線 | 確認 Chrome 開著、側邊面板的「AI 代理橋接」已啟用，並且貼了配對碼 |
| 「另一個 Chrome 設定檔正在使用橋接」 | 在你要用的那個設定檔，打開側邊面板，按「改用這個設定檔」 |
| 一直卡在冷卻 | Flow 要求放慢速度，佇列會自動等待後繼續 |
| 「異常活動」或「點數不足」 | 佇列會自動停止，請到 Flow 確認帳號狀態 |
| 素材找不到 | 名稱必須和 Flow 裡的素材標題完全一樣；請代理先執行 `flow_list_assets` 列出正確名稱 |

## 6. 安全性

- 橋接只聽本機 `127.0.0.1`，預設關閉，網頁無法呼叫。
- 擴充功能和橋接程式用配對碼互相驗證。
- **更換配對碼：** 刪除 `~/.flow-queue/token`，重新啟動橋接程式，再執行一次 `pair --copy` 並貼上新的配對碼。

## 給開發者

- 架構與協定：[`docs/DESIGN.md`](docs/DESIGN.md)。
- 代理開發這個 repo 的規則：[`AGENTS.md`](AGENTS.md)。
- 測試：`node test/background.test.js`、`node flow-queue-bridge/test/smoke.js`。
