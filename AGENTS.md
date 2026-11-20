# AGENTS.md — Flow Queue

You are probably here for one of two reasons:

- **Operating Flow Queue for a user** (queueing prompts into Google Flow, waiting, downloading). Read §1–§5.
- **Changing this repository.** Read §6.

Talk to the user in their language (default: Traditional Chinese, zh-TW). Every generation spends the user's Google Flow credits.

<!-- SAFETY:BEGIN -->
## Safety rules (non-negotiable)

1. **Every generation spends the user's Google Flow credits.** Before adding more than a handful of prompts, tell the user how many prompts and ask. The extension refuses batches above its limit (default 20) unless you pass `confirm: true` — only set it after the user agreed.
2. **Never resubmit `unknown` items without asking.** `unknown` means it was sent but the result could not be confirmed; it may already have generated and spent credits. Ask the user to check Flow first; only then retry with explicit ids and `confirm_unknown: true`.
3. **Always pass your own stable `request_id` to `flow_add_prompts`** and reuse the same one if you retry after a timeout or error. Never re-add prompts blindly — list the queue first.
4. **Never read, print, log or ask for the pairing token** (`~/.flow-queue/token`, `flowq pair` output). If pairing is needed, tell the user to run `flowq pair --copy` themselves and paste it into the side panel.
5. **Never change bridge settings** (enable, port, token) and never edit the user's MCP configs without being asked.
6. **Download before you clear.** `flow_clear` / `flow_remove` delete result records.
7. **One Flow project at a time.** If several Flow project tabs are open (`multiple_flow_tabs`), ask the user which one and pass `tab_id`.
8. **Human-only steps** — installing the extension, signing in to Google, opening a Flow project, pasting the pairing code, accepting Chrome prompts — ask for one step at a time, relay `flow_doctor`'s `fix` text verbatim, then re-run `flow_doctor`.
<!-- SAFETY:END -->

## 1. What it is

| Part | Path | What it does |
|---|---|---|
| Chrome extension | `flow-queue/` | Runs in the user's Chrome profile. Types prompts into Flow, attaches refs, presses Generate, tracks results. Fixed ID `ofbmccbjodncofoookgajjnodeamnada`. |
| Bridge daemon | `flow-queue-bridge/server.js` | Local daemon on `127.0.0.1:17345` that relays calls to the extension over an authenticated WebSocket. Started automatically. |
| MCP server | `flow-queue-bridge/mcp.js` | The `flow_*` tools. Its `initialize` result carries `agent-instructions.md` (the rules above plus the loop below). |
| CLI | `flow-queue-bridge/cli.js` (`flowq`) | The same operations. Prints JSON when stdout is not a TTY. |

Generation settings (model, aspect ratio, outputs per prompt) are whatever is selected in the Flow UI. Flow Queue does not change them, so ask the user to set them first if it matters.

## 2. First-time setup (agent-led)

Do the machine steps yourself. Ask the human for the steps marked 👤, **one at a time**, and run `flow_doctor` / `flowq doctor` after each.

1. Clone the repo, if it isn't already there: `git clone https://github.com/stevenke1981/flow-queue.git`. Requires Node ≥ 18; there are no dependencies to install.
2. Register the MCP server for yourself: `node <repo>/flow-queue-bridge/cli.js install-mcp <claude|codex|agy>`. Run it with `--dry-run` first and tell the user which files it will touch; it backs them up. Afterwards the user may need to restart your session so the `flow_*` tools load. Until then, use the CLI.
3. 👤 Load the extension:
   1. Open `chrome://extensions` and turn on Developer mode.
   2. Click "Load unpacked" and choose `<repo>/flow-queue` (give the absolute path).
4. 👤 Pair:
   1. The user runs `node <repo>/flow-queue-bridge/cli.js pair --copy` themselves. It copies the code to the clipboard and never prints it.
   2. In the extension side panel (toolbar icon or `Alt+Shift+Q`), go to 設定 → AI 代理橋接, paste the code and turn on 「允許 AI 代理控制」.
5. 👤 Open Google Flow (https://labs.google/fx/tools/flow), sign in, open or create a project, and choose model, ratio and output count.
6. Run `flow_doctor` and repeat until all checks pass. Each failing check has `code`, `fix` (zh-TW, relay verbatim) and `fix_en`.

## 3. Recipes

**Batch of prompts.** Split by blank lines (or one per line) and ask the user before more than 20.
```json
flow_add_prompts {"prompts": ["a cat on a rainy windowsill, 35mm", "a neon night market"], "request_id": "batch-2026-11-20-cats", "start": true}
```
Then call `flow_wait {"ids": [...]}` repeatedly until `done`. Then call `flow_download {"ids": [...]}` to get absolute paths.

**With characters / Flow library assets.**
1. Call `flow_list_assets {"category": "Characters"}` (or Images / Uploads / Videos / All) to get exact titles.
2. Add with `"characters": ["小明"]` and `"assets": ["台北街景背景"]`, either for the whole batch or per prompt: `{"prompt": "...", "characters": [...]}`.

Names must match exactly one asset. A missing or ambiguous name fails that item without spending credits.

**With reference images.** Pass `"images": ["C:/path/a.png", "https://…/b.jpg"]`.
- Allowed: png, jpg, webp, gif, avif or heic, up to 10 MB each.
- URLs must be public; private or loopback addresses are blocked.
- Each image is uploaded to the Flow project once, then reused.

**Resume after an interruption, or after a tool timeout.**
1. Call `flow_list_queue` (filter by status) and compare against your batch.
2. If you are unsure whether an add went through, resend it with the same `request_id`. It is deduplicated for 10 minutes.

**Triage failures.**
- `failed`: read `error`. Fix the cause (wrong asset name, policy refusal, …), then call `flow_retry {"ids": [...]}`, or let the user decide.
- `unknown`: never auto-retry; see Safety rule 2.

**Pause, stop and cooldowns.**
- `flow_pause` lets in-flight generations finish.
- `flow_stop` marks in-flight items `unknown`.
- After a rate limit the queue cools down by itself.
- After "unusual activity" or "insufficient credits" the queue stops. Tell the user and don't restart without them.

**Several Chrome profiles.** Only one profile holds the bridge. If doctor reports that another profile is connected, the user presses 「改用這個設定檔」 in the profile they want.

## 4. Tools

| MCP tool | CLI | Notes |
|---|---|---|
| `flow_doctor` | `flowq doctor [--no-start]` | Checks daemon → extension → flow_tab → queue. Starts the daemon if needed. |
| `flow_status` | `flowq status` | Run state, counts, open Flow tabs and bridge state. Never includes the token. |
| `flow_add_prompts` | `flowq add <prompt…> [-f file] [--split blank\|line] [--image p] [--character n] [--asset n] [--request-id id] [--confirm] [--top] [--start]` | Returns `{added, ids, request_id, deduped?}`. Spends credits once started. |
| `flow_start` | `flowq start [--tab id]` | Returns `{tabId, title, url, projectId}`. Errors with `multiple_flow_tabs` or `no_flow_tab`. |
| `flow_wait` | `flowq wait <ids…> \| --all [--timeout s]` | Each call returns within about 45 s with `{done, timedOut, stalled?, next?, run, counts, items}`, covering only your ids. |
| `flow_download` | `flowq download <ids…> \| --all-done [--no-wait]` | Returns `{files:[{id, seq, index, path, state, reused?}], errors}`. Paths are absolute; files that were already downloaded are reused. |
| `flow_list_queue` / `flow_get_item` | `flowq list [--status s]` / `flowq get <id>` | Item fields: `status` (pending, running, done, failed or unknown), `error`, `results`, `refs`. |
| `flow_retry` | `flowq retry [ids…] [--status s] [--confirm-unknown]` | Defaults to `failed` only. |
| `flow_pause` / `flow_stop` | `flowq pause` / `flowq stop` | |
| `flow_remove` / `flow_clear` | `flowq remove <ids…>` / `flowq clear <done\|failed\|all>` | Destructive: download first. |
| `flow_list_assets` | `flowq assets [--category c] [--search s]` | Opens Flow's picker. Refused (`busy`) while the queue is typing. |
| `flow_settings` | `flowq settings [key=value…]` | Pacing, retries, timeouts, auto-download. Bridge keys and the batch limit are locked. |
| `flow_logs` | `flowq logs` | Recent extension log. |
| – | `flowq agent-guide` | Prints the operating rules, for CLI-only agents. |
| – | `flowq install-mcp <claude\|codex\|agy\|all> [--dry-run]` | Idempotent, with backups. |

**CLI conventions:**
- Output is JSON when stdout is piped; `--human` / `--json` override.
- Exit codes: 0 ok, 1 error (`{ok:false, code, error}`), 2 usage error.
- `flowq pair` refuses to print to a pipe.

## 5. Error codes

| code | meaning → action |
|---|---|
| `daemon_unreachable` | Daemon down or token rejected → run `flow_doctor` and relay its `fix`. |
| `extension_not_connected` | Chrome closed, bridge off, not paired, or another profile holds the bridge → relay doctor's `fix`. |
| `no_flow_tab` / `multiple_flow_tabs` | No Flow project tab open / ask which one and pass `tab_id`. |
| `confirm_required` | Batch over the limit → ask the user, then resend with `confirm: true` and the same `request_id`. |
| `unknown_requires_confirm` | Retrying `unknown` items → the user must check Flow first. |
| `busy` | The queue is operating Flow, or cooling down → wait and call again. |
| `stalled` (wait only) | Paused, not started or stopped → follow `next`. |
| `timeout` / `extension_error` | Check `flow_status` / `flow_logs` before doing anything else. |
| `not_found` / `invalid_argument` | Fix your call. |

## 6. Developing this repository

- **Contract first.** `docs/DESIGN.md` defines messages, storage, the bridge protocol and these tools. Update it before changing behaviour.
- **Layout.**
  - `flow-queue/`: MV3 extension.
    - `background.js` is the single writer of `chrome.storage.local`, and holds `FQ.call` for the bridge.
    - `content.js` drives the Flow DOM; the selectors are in its "Flow DOM" and "ingredients" sections.
    - `sidepanel.*` is the UI.
    - `bridge-client.js` handles the WebSocket and HMAC pairing.
  - `flow-queue-bridge/`: zero-dependency Node daemon, MCP server and CLI.
  - `test/`: tests for the extension's background script.
- **Tests (must pass):** `node test/background.test.js` and `node flow-queue-bridge/test/smoke.js`. The smoke test checks that the Safety block in this file matches `flow-queue-bridge/agent-instructions.md` exactly; edit both together.
- **Rules.**
  - No runtime dependencies.
  - User-facing strings in Traditional Chinese.
  - Never use a real token, HOME or MCP config in tests.
  - Keep the manifest `key`, since it pins the extension ID the daemon trusts.
  - The private key lives outside the repo, in `~/.flow-queue/extension-key.pem`.
- **Credit safety.** Code paths must never resubmit something that may already have been sent:
  - `submittedAt` is recorded before the click.
  - Timeouts become `unknown`.
  - Stale claims are ignored via `claimId`.
- **Not testable offline.** The Flow DOM itself can't be tested here. After changing `content.js`, test manually on a real Flow project with 1–2 cheap prompts.
