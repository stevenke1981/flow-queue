# Flow Queue — operating rules for agents

Flow Queue queues prompts (with optional characters, Flow library assets and reference images) into **Google Flow** in the user's own Chrome, waits for the results and downloads them. You drive it with the `flow_*` MCP tools (or the `flowq` CLI, which prints JSON when piped). Talk to the user in their language (default: Traditional Chinese).

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

## Standard loop

1. `flow_doctor` — fix anything not ok (human steps: relay `fix`, wait, re-check).
2. If prompts use characters/assets: `flow_list_assets` to get exact titles (names must match one asset exactly; ambiguous or missing names fail the item without spending credits).
3. `flow_add_prompts` with `request_id` (+ `confirm: true` only after the user approved a large batch). Keep the returned `ids`.
4. `flow_start` (pass `tab_id` if asked). It uses the model / aspect ratio / output count currently selected in the Flow UI — tell the user to set those first if it matters.
5. `flow_wait` with those `ids`; each call returns within ~45 s. Repeat while `done` is false. If `stalled` is set (paused / cooldown / idle_not_started / stopped), handle it instead of spinning.
6. `flow_download` with the ids → absolute file paths. Report paths, failures (with their `error`) and `unknown` items to the user.

## Error codes → what to do

| code | action |
|---|---|
| daemon_unreachable | run `flow_doctor`; the daemon auto-starts — if it still fails (or says the token was rejected), show the user the doctor `fix` |
| extension_not_connected | ask the user to open Chrome, enable 「允許 AI 代理控制」 and paste the pairing code (`flowq pair --copy`). If another Chrome profile holds the bridge, ask them to press 「改用這個設定檔」 in the profile they want |
| busy | the queue is operating Flow or cooling down after a rate limit — wait and call again; don't resubmit |
| stalled (`flow_wait` / `flowq wait`) | read `stalled` + `next`: `paused` → ask before `flow_start`; `idle_not_started` → `flow_start`; `stopped` → read `run.message` (e.g. credits, unusual activity) and tell the user |
| no_flow_tab | ask the user to open a Flow project (https://labs.google/fx/tools/flow) and sign in |
| multiple_flow_tabs | ask which tab; retry `flow_start` with `tab_id` |
| confirm_required | ask the user to approve the count; resend with `confirm: true` and the same `request_id` |
| unknown_requires_confirm | ask the user to check Flow; only then retry with `confirm_unknown: true` |
| not_found / invalid_argument | fix your arguments; don't retry unchanged |
| timeout / extension_error | run `flow_status` / `flow_logs`, then decide; never re-add without checking the queue |

Full guide: AGENTS.md in https://github.com/stevenke1981/flow-queue
