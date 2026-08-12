# WaterX Predict 通用 Agent 安裝與執行規劃

> 狀態：核心 baseline 已確認；P0 與交易語義決策已全數收斂為 ADR  
> 更新日期：2026-08-12  
> 影響範圍：`waterx-predict-agent-sdk`、`bucket-backend-mono`  
> 不在預設修改範圍：`waterx-contract`、`bucket-quant`

> **本文件是規劃敘述，不是實作狀態。** 具約束力的決策在 `docs/adr/`；實際實作
> 進度只由 `docs/IMPLEMENTATION_BACKLOG.md` 記錄。三者衝突時：ADR > backlog >
> 本文件。本文件提到的任何能力都不代表已實作。

## 1. Executive summary

WaterX Predict 現有實作已具備受保護市價單的主要交易流程，但產品介面仍以
「工程師把 TypeScript SDK 嵌進自己的 Node.js bot」為主。若目標改為讓不同
agent 在安裝後理解使用者意圖並直接操作，不能只增加 MCP，也不能只提供一份
prompt；需要一個與 agent host 無關、可被程式發現、可安全執行且可長時間運作的
agent-facing runtime。

建議採用以下分層：

1. REST/WS API 是唯一交易與資料來源。
2. TypeScript SDK 保持 wire-level client 與安全 orchestration 的角色。
3. CLI 提供所有能執行 shell 的 agent 一致、結構化的操作面。
4. Durable Runner 持有 signer、連線與任務狀態，承擔長時間策略。
5. JSON Schema/OpenAPI 與 agent instructions 提供機器可讀能力描述及操作規則。
6. MCP、各家 tool/function calling、Skill 是薄 adapter，不是核心依賴。

```text
User intent
   │
   ▼
Claude / Codex / custom agent / Node bot
   │
   ├── shell ─────── waterx-predict CLI ───────┐
   ├── MCP ───────── optional MCP adapter ─────┤
   ├── HTTP ──────── REST/OpenAPI ─────────────┤
   └── TypeScript ── SDK ──────────────────────┤
                                                ▼
                                  Local or managed Agent Runner
                                  signer / auth / jobs / streams
                                                │
                                                ▼
                                      WaterX REST/WS API → Sui
```

MCP 應保留為官方 adapter，但不是「任何 agent 可使用」的前置條件。最低支援條件
是 agent host 至少能使用 HTTP、Node.js library、shell command 或 MCP 其中一種。
完全沒有外部工具能力的純聊天模型無法安全地執行交易。

## 2. 已確認的產品原則

以下決策已由現有 SPEC、程式碼及討論確認，實作時不應重新打開：

- 後端只有帶價格保護的市價單；不增加後端 limit/conditional order。
- 合成限價由 client-side runner 監聽，觸發後取得 fresh executable quote 並重新驗證。
- 多個 action 可以串連。
- 多筆訂單可以並行或依序執行，但每筆獨立成功或失敗；沒有原子 batch 與 rollback。
- Delegation 已存在並維持外部安全邊界；agent runtime 不得模擬或弱化它。
- WaterX quote 是唯一可用交易報價；不由 SDK 推導 raw orderbook 價格。
- Package 尚未發佈，可為一致的 public API 進行 breaking redesign。
- Runtime dependency 可以增加，但必須能說明用途、安全維護狀態與安裝成本。
- 正常開發只修改 SDK repo 與 `bucket-backend-mono`；contract、quant 預設只讀。
- MCP/Skill 是選配整合，不應成為通用核心的唯一入口。

### 2.1 2026-08-12 決策紀錄

以下架構決策已確認，視為後續實作 baseline：

- 通用 canonical agent interface 採 CLI + JSON Schema；MCP/function calling 僅為薄
  adapter，不另做交易語義。
- Beta 採 self-hosted local Runner，不提供 managed Runner 承諾。
- Agent 所在裝置與 Runner 必須持續運行；裝置關機、休眠、斷網或 Runner 停止期間，
  WaterX 不保證 client-side 到價策略會被監控或執行。
- Approval 預設為 `interactive`；只有使用者明確啟用、且符合 backend risk profile 與
  scoped local policy 時，才允許 `delegated-auto`。
- Signer 保留在 Runner trust boundary，採 provider interface；模型與一般 agent
  subprocess 不得取得 raw private key。
- 本機 durable job store 採 SQLite/WAL，並保留 store interface 供未來替換。
- 「賣現在持倉的一半」預設在建立 job 時將 shares 固定；動態比例必須使用不同且
  明確的 schema 欄位。
- Market resolution 只接受 server-resolved identity；backend 需提供可預期的
  search/aliases。Quote WS 採 snapshot + monotonic sequence + gap recovery，先定 SLO
  再宣稱 real-time。
- Repository 採多 package 邊界，將 SDK、CLI、Runner 與 optional MCP adapter 分離。

上述決策若要變更，必須以 ADR 說明相容性、安全性與營運影響，不能在單一 adapter
或 feature implementation 中隱式改變。

## 3. 目標與非目標

### 3.1 目標

- 使用者完成一次性的錢包、delegation、risk profile 設定後，agent 可自行發現能力。
- Agent 可將自然語言轉成可驗證的 market、outcome、side、size 與價格保護。
- Read 與 preview 不移動資金；write 只能在預先授權的 policy 內自動執行。
- 所有輸出都有穩定 JSON schema、symbolic error code 與可追蹤 execution/job ID。
- 長時間策略可跨 token 過期、網路中斷與 runner restart，不重複下單。
- 同一個核心可以被 CLI、MCP、Node agent 與其他 function-calling host 共用。
- 使用者能從執行紀錄回答「agent 為什麼做、送了什麼、實際成交如何」。

### 3.2 非目標

- 在 SDK 內建交易判斷、勝率模型或推薦下注。
- 讓 LLM 直接讀取或輸出私鑰。
- 將條件單狀態偽裝成 WaterX backend order。
- 提供原子多腿成交保證。
- 由 SDK 自行建立 protocol transaction 或重做 delegation 邏輯。
- 首版支援 Python SDK。
- 將 MCP server 視為唯一或必要的安裝形式。

## 4. 現況與六個情境差距

| SPEC 情境 | 現況 | 上線前主要缺口 |
| --- | --- | --- |
| 1. 讀市場形成判斷 | 已有 market list/detail、event facts、indicative bid/ask/probability 與 executable quote | 歷史價格、native quote WS、size-aware quote、穩定 market search/resolution |
| 2. 查自己狀態 | 已有 allowance、positions、executions、fills 與未實現 PnL | 完整 delegation/risk facts、cursor pagination、跨入口的完整活動與一致 account summary |
| 3. 下單 | 已有 delegation re-check、re-quote、slippage、idempotency、sign/submit 與 terminal reconciliation | SDK 直接回傳 terminal fill/fee/remaining allowance、真實環境 E2E、token lifecycle |
| 4. Agent 失控 | 已有 static risk limits、velocity、in-flight、suspend 與 revoke-on-next-write | read/write 分級 rate limit、異常熔斷、owner notification、runner local policy 與 revoke signal |
| 5. 事後檢視 | 有 raw execution/fill/position 與 `agent_wallet`/`strategy_id` 基礎 | realized PnL、勝率、交易數、agent performance API/後台與完整 attribution |
| 6. 策略代執行 | 有 `executeMany` 與 in-process `waitForPriceAndExecute` | durable job、quote/execution streams、auth refresh、restart recovery、通知與北極星 E2E bot |

目前最成熟的是情境 3 的 write plane。情境 6 的 helper 可以證明交易語義，尚不能
當成無人值守的產品 runtime；情境 5 則仍主要是資料 groundwork。

`priority_score` 不建議列為交易介面 P0。它是 WaterX 的 browse/ranking signal，不是
agent 的可靠交易 signal；若未來提供，必須標示用途與更新語義，不能讓 agent 將它
誤解為交易建議。

## 5. 目標使用體驗

### 5.1 一次性人類設定

資金授權不能靠模型自行猜測或偷偷完成。使用者先在可信任流程完成：

1. 建立或指定 agent Sui wallet。
2. 主錢包設定 delegation。
3. 主錢包設定 WaterX risk profile，包括 account、allowance、單筆、每小時與 in-flight
   限制。
4. 安裝 runtime，設定 API environment、default account 與 signer provider。
5. 選擇本機 execution policy：互動確認或預先授權自動執行。
6. 執行 `doctor`，驗證 auth、delegation、risk profile、WS 與測試環境。

Owner risk profile 的建立或修改仍屬 owner-authenticated UI/API，不應由 agent credential
取得。Agent 可以讀取影響自己的有效限制，但不能用相同 credential 提高限制。

### 5.2 Agent 自我發現

Agent 不應依賴爬 README 後自己拼 command。CLI 應提供：

```bash
waterx-predict describe --json
waterx-predict command-schema --command order.execute --json
waterx-predict doctor --json
```

`describe` 至少回傳：

- CLI、schema 與 API version。
- 支援的 commands、side、size semantics 與 execution modes。
- environment、default account、wallet address，但不含任何 secret。
- server capabilities，例如 quote stream 是否可用。
- write policy、有效 risk limits 與是否需要人工確認。
- backend 已知限制，例如 quote 是 size-blind 或 fee 不可知。

### 5.3 單筆即時交易

使用者：

> 用 50 買今晚 A 對 B 的 BTTS Yes，最多滑 1%。

預期流程：

1. Agent 搜尋 event 與 market，不自行生成 market ID。
2. 若 event、market、outcome、account 或 size unit 有歧義，先要求使用者確認。
3. 取得 account state 與 executable quote。
4. 執行 `order preview`，取得 normalized intent、worst price、有效 risk 與 warnings。
5. 依 execution policy 要求一次確認，或在預先授權範圍內自動執行。
6. 使用一個持久 idempotency key create → sign → submit。
7. 以 execution stream 加速，最後用 REST 確認 terminal state。
8. 回報 actual price/size、fee、transaction digest、剩餘 allowance；timeout 則回報
   `UNKNOWN_PENDING`，不得宣稱失敗或用新 key 重送。

### 5.4 到價策略

使用者：

> BTTS Yes 的 bid 到 0.82 時，賣掉現在持倉的一半，最多滑 0.5%。

Agent 不應維持一個數小時不結束的 tool call，而是建立 durable job：

```bash
waterx-predict strategy create --file intent.json --json
```

回傳 `jobId` 與 `WATCHING` 後，Runner 負責：

- 保存 normalized intent 與 idempotency key。
- 訂閱 quote stream，偵測 gap 後重新 snapshot/reconcile。
- 在 target 命中時取得 fresh executable quote 並重驗 target。
- 重新確認 delegation、risk 與 position。
- 至多提交一個 logical execution。
- token 過期時安全重新認證。
- restart 後從 durable state 恢復，不重複下單。
- 將 terminal/failed/expired/cancelled 結果送到可配置 notification sink。

這個 job 是 client runtime state，不是 WaterX backend conditional order。若使用者停止
runner，條件不會觸發；產品介面必須明確呈現 runner health 與最後 heartbeat。

### 5.5 多腿策略

每一腿都必須有自己的：

- resolved market/outcome；
- fresh quote；
- position（SELL 時）；
- idempotency key；
- execution result。

因 quote lifetime 很短，不可先取得所有 quote 再慢慢送出。Runner 應在每一腿接近
執行時 quote，並以 bounded concurrency 執行。結果必須分為：

- `SUCCEEDED`：已取得 terminal success/fill facts；
- `FAILED`：已嘗試但失敗，保留 execution/key 供 reconciliation；
- `SKIPPED`：STOP policy 下尚未啟動，可安全由使用者重新決策。

不提供「整組成功」假象，也不嘗試 rollback 已送出或已成交的腿。

## 6. 建議架構

### 6.1 Package topology

建議在同一個 repository 轉為 pnpm workspace，將核心與安裝介面隔離：

```text
packages/
  sdk/       @waterx/predict-agent-sdk       wire client and safe orchestration
  cli/       @waterx/predict-agent-cli       waterx-predict executable
  runner/    @waterx/predict-agent-runner    durable jobs, signer, streams, policy
  mcp/       @waterx/predict-agent-mcp       optional thin adapter
schemas/                                      versioned agent command schemas
agent-instructions/                           host-neutral instructions and examples
examples/                                     testnet one-shot and north-star bots
```

Package 尚未發佈，因此建議現在完成拆分，避免把 daemon、storage、CLI parser 與 MCP
dependencies 塞進 SDK library。若時程優先，也可先維持單 repo/root SDK，再逐步搬移；
但 public package 名稱、CLI name 與 config format 必須在首個 beta 前凍結。

### 6.2 SDK responsibilities

SDK 應負責：

- REST transport、auth、safe retries 與 stable errors。
- Native execution stream，以及 backend 可用後的 native quote stream。
- Create/sign/submit orchestration 與 authoritative terminal reconciliation。
- Fresh-quote target re-verification。
- `executeMany` 的 bounded, independent orchestration。
- 可注入 transport、stream、signer 與 clock，供測試及特殊 caller 使用。

SDK 不應負責：

- 保存終端使用者 secrets。
- 以 memory state 冒充 durable strategy service。
- 自然語言解析或市場推薦。
- owner risk profile 的提權操作。

`executeMarketOrder(..., { waitFor: 'TERMINAL' })` 應回傳 terminal read 的完整 fill 與
remaining allowance，而不是丟棄後只留下 execution status。非 terminal timeout 則必須
保留 execution ID，讓上層進入 reconciliation。

### 6.3 CLI responsibilities

CLI 是通用 agent-facing interface，所有 command 都應：

- 支援 `--json`，stdout 只能輸出一個穩定 JSON document 或 JSON Lines stream。
- 將 diagnostics 放 stderr，且不得輸出 token、signature、transaction bytes 或 secret。
- 使用穩定 exit code 與 symbolic `error.code`，不能要求 agent 解析英文句子。
- 支援從 stdin/`--file` 輸入完整 JSON，避免秘密或大型 payload 出現在 process args。
- 在輸出中帶 `schemaVersion`、request/execution/job IDs 與 server trace ID。
- 預設禁止 ANSI color、interactive prompt 與表格污染 agent mode。
- write command 必須接受 caller-supplied idempotency key；未提供時由 Runner 持久生成。

建議 command surface：

```text
describe
doctor
market list | search | get | quote | history
account status | positions | executions | fills
order preview | execute | execute-many | get | reconcile
strategy create | get | list | cancel | events
runner status | start | stop
```

`preview` 是必要的一級操作，不只是 `quote` 的別名。它應回傳 normalized user intent、
market/outcome identity、size unit、reference quote、worst acceptable price、effective risk
limits、warnings 及「目前是否允許 execute」，但不能簽章或移動資金。

### 6.4 Durable Runner responsibilities

Runner 是 signer 與長時間狀態的 trust boundary。CLI/MCP 應透過 local IPC 或 authenticated
remote channel 呼叫 Runner，而不是讓每個 agent subprocess 讀私鑰。

必要 job state machine：

```text
DRAFT → WATCHING → TRIGGERED → QUOTING → CREATING → AWAITING_SIGNATURE
      → SUBMITTING → SUBMITTED → RECONCILING → FILLED | FAILED | CANCELLED | EXPIRED
```

另需有 `UNKNOWN_PENDING`，表示 caller/runner 失去確認能力，但 execution 可能已存在。
此狀態只能以原 execution ID 或 idempotency key reconcile，不能建立新 intent。

Runner 必須在任何外部 side effect 前持久化：

- job ID、strategy ID 與 owner/account/agent wallet。
- normalized intent、trigger semantics 與 policy snapshot。
- idempotency key。
- reference/submission quote IDs 與 timestamps。
- execution ID、submission/keeper transaction digests。
- stream cursor、last heartbeat 與 transition audit log。

儲存層需要 transaction、unique constraints 與 crash recovery。單純覆寫 JSON file 不足以
承擔資金操作；本機版建議 SQLite/WAL，managed runner 則使用既有 transactional database。

### 6.5 Signer and secret custody

推薦 signer provider interface，而不是固定讀 `AGENT_SECRET_KEY`：

```text
Local encrypted keystore / OS keychain
External command or wallet signer
Cloud KMS/HSM adapter
Injected Sui Keypair（只供 application embedding 與測試）
```

安全原則：

- Model context、CLI args、stdout、logs 與 job database 都不能含 raw private key。
- Personal-message auth 與 transaction signing 保持不同 method。
- Signer address 必須等於 authenticated agent wallet。
- Runner 重新認證可自動進行，但重試 write 必須沿用完全相同 bytes 與 idempotency key。
- Config 可保存 signer reference，不保存未加密 secret。
- `doctor` 只能簽無資金效果的 challenge，不能用測試交易驗證 signer，除非使用者明確
  指定非 production environment。

### 6.6 Policy and approval

建議兩層 guardrail：

1. Backend owner risk profile 是不可繞過的 server policy。
2. Runner execution policy 是更嚴格的本機/受管 policy，限制哪些自然語言 intent 可以
   自動送出。

支援模式：

- `interactive`（預設）：read/preview 自動；每個 write 需要一次明確批准。
- `delegated-auto`：符合預先建立的 strategy policy 即可執行，不逐筆打斷。
- `read-only`：禁止所有簽章及 write。

自動 policy 至少可限制 account、market/category、side、單筆 size、累計 notional、
max slippage、有效時間、最大腿數與允許的 strategy IDs。Runner policy 不能顯示或承諾
比 backend effective limits 更高的權限。

### 6.7 Agent instructions and adapters

Host-neutral instructions 應規定：

- 如何發現 command schema 與 server capabilities。
- market/outcome resolution 失敗時何時詢問使用者。
- BUY target 是 ceiling、SELL target 是 floor。
- money/price/size 一律使用 decimal string。
- `buyAmount` 與 `sellShares` 不可互換。
- quote 只是短效 reference；catalog price 不能拿來下單。
- timeout、partial success、revoke、slippage rejection 的回報方式。
- 禁止把使用者模糊語句默認成高風險 size 或 account。

各 host adapter 只做 schema mapping：

- MCP adapter 將 commands 暴露成 typed tools。
- OpenAI/Claude 等 function-calling adapter 使用同一份 JSON Schema。
- Skill/plugin 提供觸發說明、工作流程與 examples。
- CLI agent 讀取 `describe` 與 host-neutral instructions。

Adapter 不得各自實作報價判斷、retry、signing 或 job state，避免相同交易在不同 host
產生不同安全語義。

## 7. Backend dependencies

以下能力不能只靠 SDK 文件或 adapter 補齊：

### 7.1 Quote stream

需要 backend 定義並實作：

- authenticated subscription 與 market/outcome topic。
- snapshot + monotonic sequence/cursor。
- reconnect replay window 與明確 gap signal。
- bid/ask/source timestamp/server timestamp/quality flags。
- heartbeat、rate limit、subscription cap 與 World Cup 容量目標。
- quote freshness 與 WS delivery latency metrics。

在 upstream 仍約 2 秒 polling 時，不應把 socket transport 宣稱成低延遲即時報價。應先
定義可達成的 SLO，再決定 feed 或推送架構。

### 7.2 Size-aware executable quote

為大戶及薄流動性市場，quote request 的 `size` 必須實際影響：

- expected average fill price；
- available/expected fill size；
- price impact；
- fee facts 或明確 unavailable；
- quality tier 與拒絕原因。

在這項能力完成前，產品要明示 `TOP_OF_BOOK_ONLY`，並將 large-size warning 傳到
preview，不得由 CLI/agent fabricated depth。

### 7.3 Account and performance reads

需決定是否增加：

- agent 可讀的 effective delegation/risk summary。
- cursor-based executions/fills/positions。
- realized/unrealized PnL、win rate、trade count 與 strategy attribution。
- direct-chain activity 是否納入 agent performance，以及如何確認 attribution。

### 7.4 Operations

至少建立：

- order success/terminal rate。
- rejection/error code distribution。
- reference quote → submission quote → actual fill deviation。
- quote freshness 與 WS delivery P50/P95/P99。
- reconnect/gap/replay rate。
- revocation-to-rejection latency。
- runner heartbeat/strategy stuck metrics（若提供 managed runner）。

## 8. Machine-readable contracts

應分開管理兩種 contract：

1. Backend wire contract：仍以 backend `agent-api.contract.ts` 為權威，SDK vendored copy
   必須完整同步。
2. Agent command contract：描述較高階的 preview、execute、strategy job 與 policy input；
   由同一份 runtime schema 產生 CLI validation、JSON Schema 與 MCP/function adapter。

Agent command schema 必須 versioned，且至少包含：

- `schemaVersion` 與 capability version。
- semantic descriptions、required fields 與 decimal-string pattern。
- read/write/long-running classification。
- side effects、idempotency requirement 與 confirmation hint。
- closed enum 與 open-set 欄位的區別。
- examples 只能使用 testnet/devnet 假資料。

不能把 TypeScript compile-time types 當成 runtime validation。採用哪套 schema library 可在
implementation spike 後決定，但必須維持一個 agent command schema source of truth。

## 9. Error and result model

所有入口需回傳一致 envelope：

```json
{
  "schemaVersion": "1",
  "ok": false,
  "command": "order.execute",
  "requestId": "req_...",
  "error": {
    "code": "SLIPPAGE_EXCEEDED",
    "message": "Human-readable summary",
    "retryable": false,
    "details": {}
  }
}
```

規則：

- 保留 server symbolic error，不建立互相矛盾的 local 判斷表。
- Local errors 使用獨立 namespace，例如 `RUNNER_UNAVAILABLE`、`POLICY_DENIED`、
  `AMBIGUOUS_MARKET`、`JOB_STORE_CORRUPT`。
- `RATE_LIMITED` 應保留 retry hint，但 Runner 仍採 bounded backoff+jitter。
- `EXECUTION_TIMEOUT` 與 `UNKNOWN_PENDING` 不得映射成交易失敗。
- Batch output 是每腿 discriminated result；top-level success 只表示 orchestration 完成，
  不能表示全部成交。

## 10. 實作階段

### Phase 0 — 規格凍結與 threat model

交付：

- 完成本文件第 11 節的 P0 決策與 ADR。
- CLI command/schema prototype 與兩個 agent host 的 discovery spike。
- Runner trust boundary、job state machine、crash/replay threat model。
- Quote WS protocol 與可達成的 SLO。
- Testnet provisioning 流程及 owner risk onboarding owner。

Exit criteria：同一份 normalized intent 經 CLI 與一個 tool adapter 產生完全相同 SDK
request；所有 secret custody 與 approval boundary 有明確 owner。

### Phase 1 — Universal one-shot interface

交付：

- Package/workspace restructuring。
- `describe`、`doctor`、market/account/order commands。
- Runtime schemas、一致 JSON envelope 與 exit codes。
- Signer provider interface、auth renewal 與 redaction。
- `preview → execute → terminal result` 完整流程。
- Testnet quickstart 與真正的「查價 → 下單 → 查部位」E2E。

Exit criteria：具備 delegation/risk profile 的新使用者可在 15 分鐘內，讓 shell-capable
agent 完成第一筆 testnet 交易；token 在流程中過期不會造成 duplicate execution。

### Phase 2 — Streaming and durable strategies

交付：

- Backend quote WS、SDK native quote/execution stream。
- Gap/reconnect/REST reconciliation。
- Durable job store、Runner daemon、IPC 與 policy engine。
- `strategy create/get/cancel/events`。
- Multi-leg north-star bot、restart/kill/network-partition tests。
- Notification sink 最小版本。

Exit criteria：執行兩小時策略期間強制 token expiry、WS gap 與 Runner restart，最終仍至多
產生一個 logical execution；每一腿結果可獨立 reconciliation。

### Phase 3 — Adapters, beta and operations

交付：

- Host-neutral agent instructions。
- MCP adapter 與至少另一種 tool/function adapter，皆使用同一 command schema。
- Performance reads/admin view 的約定範圍。
- Quote-to-fill、WS latency、reject reasons dashboard。
- 薄市場大 size、熱門市場大量 subscription 壓測。
- npm release provenance、upgrade/rollback 文件與 beta support policy。

Exit criteria：同一組意圖測試在 CLI、MCP 與 Node embedding 得到一致 normalized intent、
policy decision 與 execution semantics；beta 指標可被觀測。

## 11. 決策狀態與尚需決定事項

### 11.1 P0 架構決策

| ID | 狀態 | 決策 | Baseline／建議 | 若不決定的風險 |
| --- | --- | --- | --- | --- |
| D-01 | 已確認 | 通用 canonical surface | CLI + JSON Schema；MCP 為薄 adapter | 每個 agent host 各做一套不一致的交易語義 |
| D-02 | 已確認 | Runner 由誰長期運行 | Self-hosted local runner；agent 裝置必須持續運行 | 聊天結束或電腦休眠後策略停止，卻被誤認為仍有效 |
| D-03 | 已確認 | 是否承諾 managed runner | 首版不承諾；若未來需要則獨立立項 | 若要真正「全程不用管」，local-only 體驗可能不符合產品承諾 |
| D-04 | 已確認 | Package topology/name | 同 repo 多 package；保留 SDK 名稱，另發 CLI/Runner | 單 package dependency 膨脹、release 與 trust boundary 混亂 |
| D-05 | 已確認（[ADR-0002](adr/0002-supported-platforms.md)） | 支援 OS/runtime | Node 20+ ESM；beta 只支援 macOS + Linux；Windows 未經驗證前不得宣稱 | 「任何 agent」被誤解為所有平台均可安裝 |
| D-06 | 已確認 | Signer custody | Provider interface；禁止 plaintext config；local keychain/KMS 優先 | Agent subprocess 或 prompt 洩漏私鑰 |
| D-07 | 已確認 | 自動交易批准模型 | `interactive` default；明確啟用 scoped `delegated-auto` | 每筆都確認使自動化失效，或無確認造成意外交易 |
| D-08 | 已確認 | Durable store | 本機 SQLite/WAL + store interface；實作前做安裝相容性 spike | Crash 後重複單、任務遺失或狀態無法 reconcile |
| D-09 | 已確認 | Market resolution | Backend 支援可預期 search/aliases；只接受 server ID | Agent 因模糊名稱選錯賽事或自行 hallucinate ID |
| D-10 | 已確認 | Quote WS contract/SLO | snapshot+sequence+gap；先定 SLO 再宣稱 real-time | 有 socket 但沒有正確性與延遲保證 |
| D-11 | 已確認 | Token renewal | Signer 可用時自動 re-auth；write 沿用 key/bytes | 長時間 job 在 15 分鐘後失效或重複送單 |
| D-12 | 已確認 | Terminal result shape | SDK/CLI 回傳完整 fill、fee availability、allowance | Agent 必須自行猜測或多次拼接，容易把 SUBMITTED 當成交 |
| D-13 | 已確認（[ADR-0003](adr/0003-risk-profile-ownership.md)） | Owner onboarding owner | Risk profile 寫入屬 owner-authenticated UI/API；backend 另加 agent-authenticated 唯讀 effective limits；未 onboard 需回報明確狀態 | Agent 已安裝但所有 order 因缺 risk profile 被拒 |
| D-14 | 已確認 | Schema source of truth | 一份 runtime command schema 生成所有 adapters | CLI、MCP、文件對同一欄位產生不同解釋 |

### 11.2 交易語義必須明確決定

| ID | 狀態 | 問題 | Baseline／建議 |
| --- | --- | --- | --- |
| D-15 | 已確認 | 「賣一半」以建立 job 還是觸發時持倉計算？ | 預設 freeze 建立時 shares；若要 dynamic fraction，必須使用明確不同欄位與 preview |
| D-16 | 已確認 | BUY 的自然語言 size 是資金或 shares？ | 首版 BUY 只接受 `buyAmount`，SELL 只接受 `sellShares`；含糊時詢問 |
| D-17 | 已確認 | Target 比較使用何種 price？ | BUY 比 executable ask ceiling；SELL 比 executable bid floor |
| D-18 | 已確認（[ADR-0004](adr/0004-market-lifecycle-and-job-pausing.md)） | Market 關閉、暫停、賽事延期後 job？ | 暫時不可交易進 `PAUSED` 並等恢復；`CLOSED`/`RESOLVED`/取消為 terminal；不換市場、不延長 expiry；`PAUSED` 期間仍會到期 |
| D-19 | 已確認 | 部分 fill/keeper cancellation 如何回報？ | 使用 backend terminal facts，不把 submission success 當 fill |
| D-20 | 已確認 | Multi-leg STOP 的邊界 | 只阻止尚未 launch 的腿；已 create/submit 的腿繼續 reconcile |
| D-21 | 已確認 | Trigger 命中後 delegation/risk/position 改變？ | 重新讀取並以當下有效狀態決定；禁止使用建立 job 時的快取授權 |
| D-22 | 已確認（[ADR-0005](adr/0005-strategy-expiry.md)） | Strategy 到期時間 | `expiresAt` 必填，beta 最長 7 天；禁止永久 watcher 與自動延長；到期不取消已送出的 execution |

### 11.3 可在 beta 前決定

以下項目刻意保持未決，且不阻擋 Phase 0/1；追蹤位置為
`docs/IMPLEMENTATION_BACKLOG.md` 第 7 節，beta 前必須收斂。

| ID | 決策 | 建議 |
| --- | --- | --- |
| D-23 | 通知通道 | 先支援 webhook + durable event log；email/push 後續 |
| D-24 | Agent performance 是否含 direct-chain trades | 首版只標示 API-attributed；不要混合成看似完整的勝率 |
| D-25 | Historical quote window/granularity | 由產品情境定最小集合；不要讓 CLI 自行保存後冒充完整歷史 |
| D-26 | Runtime auto-update | 預設不在有 active jobs 時自動升級；提供 drain/migrate/rollback |
| D-27 | Release artifacts | npm provenance/SBOM 必要；container image 視 managed/self-hosted 需求 |
| D-28 | MCP 是否首波一起發佈 | 若首波明確涵蓋 Claude/Codex，與 CLI 同 schema 發薄 adapter；否則 Phase 3 |
| D-29 | CLI/local API version support window | Beta 至少做 capability negotiation，拒絕不相容 write，不 silent downgrade |
| D-30 | Telemetry/privacy | 預設不收自然語言 prompt 或 secret；只收必要 operational IDs/metrics |

## 12. 已確認的 implementation baseline

以下 baseline 已確認，可直接用於 Phase 0 與後續 ADR：

1. `waterx-predict` CLI 是「任何 shell-capable agent」的 canonical interface。
2. REST/WS + TypeScript SDK 仍是 canonical execution implementation。
3. MCP 與其他 function tools 只包 CLI/Runner command schema，不重做交易邏輯。
4. 首波 Runner 是 user/self-hosted local daemon；agent 所在裝置與 Runner 必須持續
   運行，關機、休眠、斷網或停止 Runner 後不會繼續監控策略。
5. 預設 interactive；只有 owner 明確設定 local policy 與 backend risk profile 後才開
   `delegated-auto`。
6. Signer 存在 Runner trust boundary，agent/model 永遠拿不到 raw key。
7. 本機任務用 SQLite/WAL 持久化；每個 logical order 的 key 在 wait 前寫入。
8. BUY 僅用 `buyAmount`，SELL 僅用 `sellShares`；自然語言 unit 含糊就不交易。
9. 「賣目前一半」預設在 job 建立時 freeze shares；dynamic semantics 需明確選用。
10. 先完成 quote WS protocol、auth renewal 與 E2E，再宣稱 unattended strategy 可用。

若未來 WaterX 改為承諾使用者不需維持自己的 agent process 或裝置，就必須重新開啟
D-03 並設計 managed runner。那會新增 server-side strategy state、custody/signing、
availability、通知與法遵責任；它不等同於 backend limit order，但已超出目前
「SDK helper、後端零狀態」的範圍，必須獨立立項。

## 13. 驗收標準

### 通用操作

- 一個只具 shell 能力、沒有讀過 README 的 agent，可由 `describe --json` 發現完整操作。
- 相同 intent 經 CLI、SDK 與 adapter 產生相同 normalized order 與 protection。
- 所有 read/preview/write 都有穩定 JSON schema、exit code 與 redacted log。
- Ambiguous market、outcome、account 或 size unit 不會觸發交易。

### 資金安全

- Agent/model、CLI args、stdout 與 job store 找不到 raw private key/token/signature/PTB。
- Stable idempotency 可跨 retry 與 process restart。
- Token expiry、proxy timeout 與 runner crash 不造成 duplicate order。
- Delegation revoke 後下一個 write 立即被 server 拒絕。
- `SUBMITTED`、`PENDING_FILL` 與 timeout 永遠不顯示為已成交。

### 長時間策略

- Quote gap、socket disconnect 後能 snapshot/reconcile。
- Trigger 後必定 fresh quote 並重驗 target。
- Runner restart 後 watcher 恢復，且每個 intent 至多 submit 一次。
- Runner 未運行時，CLI/adapter 清楚回報策略未受監控。
- Cancel 與 expiry 釋放 socket、timer、listener，並留下 audit event。

### 多筆訂單

- 每腿都有獨立 quote、key、execution 與結果。
- Partial success 能被 agent 正確解釋與回報。
- STOP 不會聲稱已取消或 rollback 已啟動的腿。

### 產品品質

- 具備既有 delegation/risk profile 的使用者能在 15 分鐘內完成首筆 testnet 交易。
- 北極星多腿策略可在測試環境跑完建立、盯價、觸發與 terminal reconciliation。
- Quote-to-fill deviation、WS latency、reject reasons、gap/reconnect 均可觀測。
- 薄流動性與大 size 限制在 preview 與文件中真實呈現。

## 14. 文件與範例交付

正式發佈前至少需要：

- 人類 quickstart：安裝、owner setup、testnet 第一筆交易。
- Agent quickstart：`describe`、JSON input/output、error handling。
- Security guide：signer、policy、delegation、risk 與 secret redaction。
- Strategy runner guide：常駐需求、health、restart、cancel、upgrade。
- Multi-leg guide：partial success、STOP 與 reconciliation。
- Adapter guide：如何用相同 schema 建 MCP/function tool。
- Limitations：size-blind quote、stream SLO、attribution 與 unsupported platforms。
- 可執行 examples：one-shot、multi-leg、price trigger、revoke、slippage exceeded。

文件不能用 adapter seam 或未驗證的 backend plan 宣稱功能已完成。每一項 capability 只有
在 public path、失敗恢復、測試與操作文件皆完成後，才能由 `describe` 回報為 available。
