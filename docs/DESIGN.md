# Flow Queue v1.1 — 設計合約（references + AI bridge）

Fixed extension ID (manifest "key"): `ofbmccbjodncofoookgajjnodeamnada` → origin `chrome-extension://ofbmccbjodncofoookgajjnodeamnada`.

## 1. Queue item references

Queue item gains `refs: Ref[]` (default []).

```
Ref =
  | { type: 'asset',     name: string, category?: 'Images'|'Characters'|'Videos'|'Uploads'|'All' }  // existing Flow asset, matched by title
  | { type: 'character', name: string }                                                           // = asset in category 'Characters'
  | { type: 'file',      fileId: string, name: string, mime: string }                             // local image, bytes in chrome.storage.local['file:'+fileId]
```

Stored file record: `chrome.storage.local['file:<fileId>'] = { name, mime, base64, size, createdAt }`.
fileId = first 16 hex chars of SHA-256 of the bytes (dedupe). Files no longer referenced by any queue item are garbage-collected
by the background after REMOVE_ITEMS / CLEAR. Max 10 MB per file; format is sniffed from the bytes (png/jpeg/gif/webp/avif/heic).

Content script behavior per item: if `item.refs.length` and settings.clearIngredients → remove existing chips from the prompt
box ingredient bar first; then attach each ref in order; then type the prompt and generate. Items without refs leave the
ingredient bar untouched. A ref that cannot be found → item fails, retryable:false, error names the missing ref.
File refs are uploaded to the Flow project once; the upload's Flow asset title is cached in
`chrome.storage.local.uploadCache = { [projectId]: { [fileId]: assetTitle } }` and reused on later items.

## 2. New background messages (chrome.runtime.sendMessage, response {ok:true,...}|{ok:false,error})

| type | params | result |
|---|---|---|
| ADD_ITEMS (extended) | `prompts: (string \| {prompt, refs?})[]`, `refs?: Ref[]` (batch refs: prepended to every item's refs), `toTop?` | `{added, ids}` |
| ADD_FILE | `{name, mime, base64}` | `{fileId, name, mime, size}` |
| GET_FILE | `{fileId}` | `{file}` (content script may also read storage directly) |
| LIST_ASSETS | `{category?, search?, tabId?}` | `{assets:[{title, type, src}]}` (forwarded to the Flow tab content script) |
| BRIDGE_STATUS | – | `{bridge}` |

Settings additions: `clearIngredients: true`, `bridgeEnabled: true`, `bridgePort: 17345`.
Storage key `bridge` (written only by bridge-client.js): `{ connected: bool, lastError: string, at: number, port }`.

## 3. Background API for the bridge client

background.js exposes `globalThis.FQ = { call(method, params) → Promise<result> }` (throws Error on failure). Methods:

| method | params | result |
|---|---|---|
| status | – | `{run, settings, counts:{total,pending,running,done,failed,unknown,stopped}, flowTabs:[{tabId,title,url}], bridge}` |
| list | `{status?: string\|string[], limit?=100, offset?=0}` | `{items, total}` (items without base64) |
| get | `{id}` | `{item}` |
| add | `{prompts, refs?, toTop?, files?: [{name,mime,base64}]}` — files are stored via ADD_FILE and appended to batch refs | `{added, ids}` |
| uploadFile | `{name, mime, base64}` | `{fileId,...}` |
| start | `{tabId?}` (auto-picks: last run tab → active Flow tab → first Flow tab) | `{tabId}` |
| pause / stop | – | `{}` |
| retry | `{ids?, statuses?}` | `{retried}` |
| remove | `{ids}` | `{removed}` |
| clear | `{mode: 'done'\|'failed'\|'all'}` | `{removed}` |
| move | `{id, delta?, to?: 'top'\|'bottom'}` | `{}` |
| settings | `{patch?}` | `{settings}` |
| logs | `{limit?=50}` | `{logs}` (newest last) |
| listAssets | `{category?, search?, tabId?}` | `{assets}` |

## 4. Bridge daemon ⇄ extension (WebSocket)

Daemon (Node, zero dependencies) listens on `127.0.0.1:<port>` (default 17345, env FLOW_QUEUE_PORT).
- WS path `/ext`; daemon accepts the upgrade ONLY if `Origin === 'chrome-extension://ofbmccbjodncofoookgajjnodeamnada'` (env FLOW_QUEUE_EXT_ORIGIN may override for dev).
- Frames are JSON text:
  - handshake: see §7 (challenge → hello with HMAC → welcome with HMAC); `hello` without a valid mac is closed with 4001
  - daemon → ext: `{type:'req', id, method, params}`; ext → daemon: `{type:'res', id, ok, result?, error?}`
  - daemon → ext `{type:'ping'}` every 20 s; ext → daemon `{type:'pong'}` (also keeps the MV3 service worker alive).
- Only one extension connection; a new one replaces the old.

## 5. Bridge HTTP API (for MCP server / CLI)

- `GET /api/health` (no auth) → `{ok:true, extensionConnected, version}`
- `POST /api/call` body `{method, params}`, header `Authorization: Bearer <token>` → `{ok, result|error}`; 30 s timeout per call
  (`listAssets` 60 s); 503 when the extension is not connected, 504 when the extension does not answer in time; extension-reported errors are HTTP 200 with `ok:false`.
- Token: random 32 bytes hex at `~/.flow-queue/token` (created by the daemon if missing, file mode 600 where supported).
- Security: reject any HTTP request carrying an `Origin` header (browser pages); require `Host` to be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard); bind 127.0.0.1 only.

## 6. MCP server (stdio, JSON-RPC 2.0, newline-delimited, protocol "2025-06-18", zero dependencies)

Starts the daemon (detached) if `/api/health` does not answer. Tools:
flow_status, flow_add_prompts, flow_list_queue, flow_get_item, flow_start, flow_pause, flow_stop, flow_retry, flow_remove,
flow_clear, flow_settings, flow_logs, flow_list_assets, flow_wait.
- flow_add_prompts: `{prompts: (string|{prompt, images?, characters?, assets?})[], images?: string[] (local paths or http(s) URLs), characters?: string[], assets?: string[], to_top?: bool, start?: bool}`
  → MCP layer reads/fetches images (≤10 MB, see §7), sends each via `uploadFile`, then `add` with refs + requestId.
- flow_wait: `{timeout_sec?, ids?}` polls every 5 s; each call returns within 45 s (`{done:false, timedOut, counts}` while still running) — see §7.

CLI `flowq` (same transport): status | add <prompt...> [-f file] [--split blank|line] [--image p] [--character n] [--asset n] [--top] [--start] | start | pause | stop | list [--status s] | get <id> | retry [ids] | remove <ids> | clear <mode> | assets [--category c] [--search s] | logs | wait [--timeout s] | settings [key=value...]; `--json` for raw output.

## 7. Pairing / mutual authentication (added after adviser review — supersedes the "no auth on /ext" parts of §4)

- settings.bridgeEnabled now defaults to **false**; new setting `bridgeToken` (64 hex chars) pasted by the user into the side panel. The bridge client does not connect while the token is empty/invalid.
- The token is the same one in `~/.flow-queue/token`; `flowq pair` prints it (and the README tells the user to paste it into the side panel).
- WS handshake (after upgrade):
  1. daemon → ext `{type:'challenge', nonce}` (32 random bytes hex)
  2. ext → daemon `{type:'hello', version, extensionId, nonce: extNonce, mac: hex(HMAC-SHA256(token, 'ext:' + daemonNonce))}`
  3. daemon verifies (timing-safe), else closes with code 4001; then → ext `{type:'welcome', mac: hex(HMAC-SHA256(token, 'daemon:' + extNonce))}`
  4. ext verifies with crypto.subtle; on mismatch closes and writes bridge.lastError '橋接程式驗證失敗（配對碼不符）'. Until welcome is verified the ext ignores every req.
- Host header check applies to /ext and /api/health too. Max HTTP body 32 MB, max WS frame 32 MB.
- `add` accepts `requestId` (string); the extension dedupes repeated requestIds for 10 minutes and returns the first result. MCP/CLI generate one per add call.
- Files: max **10 MB** each; MCP sends files one `uploadFile` call at a time, then `add` with refs (not inline `files`). URL fetch: http(s) only, block private/loopback/link-local IPs after DNS resolution, no redirects to such hosts, 10 MB cap.
- flow_wait returns within **50 s** per call (`{done:false, counts}` if still running) so MCP client tool timeouts are not exceeded; the agent calls it again.

## 8. One bridge, several Chrome profiles (v1.2)

Problem: each profile's bridge-client connected and the daemon replaced the old socket (4000), so two profiles evicted each other forever.

- bridge-client persists a per-profile `instanceId` (crypto.randomUUID) in `chrome.storage.local.bridgeInstanceId` and sends it in `hello` together with `takeover: boolean` (true only for a user-initiated takeover).
- Daemon, after verifying the hello mac, when an authenticated connection already exists:
  - same `instanceId` → replace the old socket (close it with 4000 'replaced') — this is a service-worker restart of the same profile;
  - existing socket stale (no frame received for > 45 s) → replace it (4000);
  - `takeover: true` → replace it, closing the old one with **4003** 'taken over';
  - otherwise → reject the newcomer with **4002** 'busy' and keep the existing connection untouched.
  - Before closing with 4002 the daemon sends the newcomer `{type:'busy', mac: hex(HMAC-SHA256(token, 'busy:' + extNonce))}`;
    before closing the old socket with 4003 it sends it `{type:'taken', mac: hex(HMAC-SHA256(token, 'taken:' + extNonce))}`
    (extNonce = the nonce that connection sent in its own hello). Only a daemon holding the token can make a profile stop retrying.
- `takeover:true` is used for exactly one hello: the client clears the flag as soon as that hello is sent and on every
  close / handshake-timeout / connect-failure path, so later automatic retries always send `takeover:false`.
- bridge-client close handling (4002/4003 count only when the matching signed busy/taken frame verified; an unsigned or
  forged 4002/4003 is treated like any other drop → 'offline' with normal backoff):
  - 4000 → normal reconnect with backoff; if the socket was authenticated, first regenerate and persist a new
    `instanceId` (another live socket uses ours, e.g. a cloned profile directory), so the retry is answered 4002 instead of
    evicting the other socket again;
  - 4002 → `bridge.code='busy'`, lastError '另一個 Chrome 設定檔正在使用橋接'; no fast backoff — retry only on the 'bridge' alarm (≥ 60 s between attempts), so it takes over automatically once the other profile disconnects;
  - 4003 → `bridge.code='taken'`, lastError '已被另一個 Chrome 設定檔接管'; NO automatic reconnect until the user takes over again or changes bridge settings.
    The 'taken' state survives service-worker restarts but is cleared on `chrome.runtime.onStartup` (browser restart): the
    retry sends takeover:false, so it cannot evict the other profile — at worst it is answered busy.
- `chrome.storage.local.bridge` gains `code`: '' | 'busy' | 'taken' | 'auth' | 'offline' | 'disabled' | 'no-token'.
- `globalThis.FQBridge.reconnect({ takeover: true })` performs a takeover; background message `BRIDGE_TAKEOVER` calls it; the side panel shows 「改用這個設定檔」 when code is busy or taken.
- `GET /api/health` also returns `{ instance: <short instanceId prefix or null> }`.

## 9. Downloading blob: results (v1.2)

Flow sometimes renders results with page-scoped `blob:` URLs, which the service worker cannot download and which die on reload.
- content.js stores `results[].mediaId` and prefers a durable URL (img/video/source/a attributes containing `getMediaUrlRedirect` or `flow-content.google`) over `blob:`.
- DOWNLOAD with a `blob:` url (or `fetchViaTab: true`) is routed by the background to the Flow tab: content message `FETCH_MEDIA {src, mediaId}` → `{ok, dataUrl, mime, ext}`; the content script first fetches the stored blob URL, and if that fails, finds the tile by mediaId in the current page and fetches its current source. Cap 40 MB. Background then downloads the data URL.
