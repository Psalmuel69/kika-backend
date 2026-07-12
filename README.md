# Kika Backend

Zero-signup, multimodal WhatsApp ledger book and automated receipt engine
for informal merchants. A merchant never "signs up" — their WhatsApp
number *is* their account, created implicitly on first contact. Kika
understands typed text, voice notes, and photos, replies in the
merchant's own language (English, Nigerian Pidgin, Yoruba, Igbo, or
Hausa), and falls back to an AI safety net whenever its fast regex
parser doesn't recognize the phrasing — so no message is ever silently
lost.

## Architecture

```
                      ┌──────────────────────┐
 WhatsApp Cloud API ─▶│  Express API (api)   │──▶ enqueue ─┐
   (message broker)   │  - webhook intake     │            │
                      │  - access control gate│            ▼
                      │  - Paystack webhook   │      ┌─────────────┐
                      │  - receipt/link serve │      │  Redis /    │
                      │  - admin + audit      │      │  BullMQ     │
                      └──────────┬────────────┘      └──────┬──────┘
                                 │                           │
                                 ▼                           │
                          ┌─────────────┐                    │
                          │  Postgres   │◀───────────────────┘
                          │  (pooled)   │      ┌──────────────────────┐
                          └─────────────┘      │  Worker process      │
                                                │  - media download/   │
                                                │    transcribe/vision │
                                                │  - regex parse       │
                                                │  - AI fallback parse │
                                                │  - render receipt    │
                                                │  - Paystack call     │
                                                │  - WhatsApp send     │
                                                │  - broker alert      │
                                                └──────────────────────┘
```

The API process only ever does three things per request: verify a
signature, write a lightweight row, and enqueue a job. All heavier work —
media download/transcription, parsing, receipt rendering, third-party
API calls, outbound messaging — runs in the separately-scaled `worker`
process. This is what keeps the HTTP path fast enough to absorb
concurrent bursts without connection pool exhaustion or event-loop
blocking.

## Core flows

### 1. Recording a transaction
1. Merchant texts something natural — including Nigerian Pidgin — like
   `Mama Tunde buy 3 carton of indomie, she pay 15k remain 12k`.
2. Webhook verifies Meta's `X-Hub-Signature-256`, finds/creates the
   merchant row, enqueues the raw message, and returns `200` immediately.
3. Worker parses the message (`ledgerParser.js`), which extracts:
   - the counterparty (`Mama Tunde`)
   - itemized quantity (`Indomie x3 carton`)
   - a **Total / Paid / Balance** split from "k"-shorthand amounts —
     `pay 15k remain 12k` resolves to Total ₦27,000 / Paid ₦15,000 /
     Balance ₦12,000
4. The entry is written inside a Postgres transaction, a themed receipt
   PNG is rendered (`receiptService.js`) showing Customer / Items / Total
   / Paid / Balance and a "Recorded in your Kika Book" confirmation, and
   pushed back into the chat as an image attached to a safe, expiring,
   unguessable URL.

### 2. Settling a debt
`Mama Tunde pay off her debt 5k` doesn't open a new entry — it applies
the payment FIFO against her oldest open balances
(`settleOutstandingDebtForCounterparty`), so partial payments across
multiple prior credit sales reconcile correctly.

### Rolling debt balance — race-condition safety
Every DEBT-affecting write (a new credit sale, or a settlement payment)
goes through a strict `BEGIN ... COMMIT` transaction with an explicit
`SELECT ... FOR UPDATE` row lock on a **`customer_balances`** account row
— one row per (merchant, customer) holding their authoritative rolling
balance:

- **`queries.lockCustomerBalance(client, merchantId, counterpartyName)`**
  creates the row if it doesn't exist yet (a race-safe
  `INSERT ... ON CONFLICT DO NOTHING`), then locks it with `FOR UPDATE`
  inside the caller's transaction.
- A second concurrent transaction touching the **same customer** blocks
  on that `SELECT` until the first transaction `COMMIT`s, then reads the
  up-to-date balance before computing its own delta — eliminating the
  lost-update race that would otherwise occur when a merchant logs
  multiple sales to the same customer within seconds of each other.
- The settlement path locks `customer_balances` **before** locking the
  individual `ledger_entries` debt rows (fixed, consistent ordering
  everywhere in the codebase), so the two lock types can never deadlock
  against each other.
- Every ledger entry also stores a permanent `balance_after_kobo`
  snapshot — the customer's rolling total immediately after that
  transaction, computed under the same lock — which the receipt card
  displays as "Customer Owes (Total)".

**This was verified, not just written:** a real concurrency test fired
25 genuinely simultaneous (`Promise.all`, separate pool connections) new
debts at the same customer and confirmed both an exact final balance
(no lost updates) and a gapless, duplicate-free sequence of
`balance_after_kobo` snapshots — the signature of correct serialization.
A second test interleaved concurrent new debts and settlements for the
same customer and confirmed the final balance matched hand-computed
arithmetic exactly, with no deadlock.

### 3. On-demand reports
- `BALANCE` — live snapshot: total in/out, net, outstanding debt.
- `SUNSET` — today's recap on demand (same content as the automatic
  evening report, see below).
- `INSIGHTS` — this month's trends on demand.

### 4. Daily Sunset Report (automatic)
Once a day (default 19:00 Africa/Lagos, configurable via
`DAILY_SUNSET_CRON`), a BullMQ repeatable job fans out to every merchant
who logged at least one entry that day and sends: sales, expenses, net,
new debt issued, top 3 moving items, and transaction count. Guarded by
`report_dispatch_log` so a duplicate scheduler tick can never double-send.

### 5. Monthly Insights (on demand / non-Premium automatic)
On the 1st of each month (default 08:00 Africa/Lagos, configurable via
`MONTHLY_INSIGHTS_CRON`), Standard and Free merchants active in the prior
month receive a plain-text summary: revenue vs. the previous month (%
change), top 3 customers by value, top 3 best-selling items, and total
outstanding debt. (Premium merchants get the richer Monthly Digest
instead — see below.) Also available on demand any time via `INSIGHTS`.

### 6. Tier purchase flow
1. Merchant texts `UPGRADE` and taps one of the WhatsApp reply buttons
   (built dynamically from every active, priced row in
   `subscription_tiers`), or texts `STANDARD` / `PREMIUM` directly.
2. Worker looks up that tier's live price/currency from
   `subscription_tiers` and calls `POST /transaction/initialize` on
   Paystack, then sends the checkout link inline into the WhatsApp thread.
3. Merchant pays. Paystack fires `charge.success` to
   `/api/v1/payments/paystack/webhook`.
4. The webhook verifies the HMAC signature, re-verifies the transaction
   status directly against Paystack's API (never trusts the webhook body
   alone), reads which tier was purchased from
   `payment_transactions.subscription_tier_id`, then atomically extends
   `subscription_expires_at` by **30 days** and moves the merchant onto
   that tier (`merchants.subscription_tier_id` FK + matching
   `onboarding_state`).
5. A "victory" webhook alert fires to the configured chat-broker
   automation sink, and a confirmation message goes out over WhatsApp.

### Subscription tiers (data-driven pricing)
Pricing, currency, billing interval, and marketing feature copy all live
in one table — **`subscription_tiers`** — instead of being hardcoded in
app code or env vars:

| Column | Meaning |
|---|---|
| `id` | Stable numeric id (seeded as 1=Free, 2=Standard, 3=Premium) |
| `name` | Tier title shown to customers — `Free`, `Standard`, `Premium` |
| `description` | Short pricing-page blurb |
| `price` | Cost per billing cycle, in major currency units (e.g. `5000.00`, not kobo) |
| `currency` | ISO 4217 code, e.g. `NGN` or `USD` |
| `interval` | `monthly` or `yearly` |
| `feature_list` | JSONB array of perk strings for the pricing page |
| `is_active` | `false` hides a retired tier from new customers (existing subscribers are unaffected) |
| `display_order` | Ascending sort position on the pricing page |
| `created_at` / `updated_at` | Timestamps; `updated_at` is kept fresh by a trigger |

**Every other table that needs to know "which plan" references this
table by foreign key** — a price change or a brand-new tier is a data
update, not a code deploy:
- `merchants.subscription_tier_id` → `subscription_tiers.id` (defaults to
  `1`/Free for every zero-signup merchant)
- `payment_transactions.subscription_tier_id` → `subscription_tiers.id`
  (which tier a given Paystack transaction was for)

`queries.getMerchantById` / `findOrCreateMerchantByWhatsappNumber` join
against `subscription_tiers` and return the tier's `name` as `plan`
(plus `tier_price`, `tier_currency`, `tier_interval`,
`tier_feature_list`) so the rest of the app reads it like a simple field
while Postgres enforces the relationship underneath — confirmed with a
real FK-violation test (attempting to set a merchant to a non-existent
tier id is rejected by the database itself, not just app-level checks).
A public `GET /api/v1/pricing` endpoint lists active tiers ordered by
`display_order` for a pricing page or in-chat picker to render without
hardcoding anything client-side.

**Note:** the pricing/feature copy in the seed data is my best
reconstruction based on this build's own feature set — I wasn't able to
render the site's JS-driven pricing page to confirm the exact wording,
so treat `description` and `feature_list` as a starting point to edit
against the real copy.

### 7. Monthly Digest (Premium only)
On the 1st of each month, Premium merchants receive the flagship visual
report instead of the plain-text Monthly Insights:
1. A **Monthly Digest card** (PNG) showing Money Inflow (+ % vs last
   month), Outstanding Credit, Trade Days, and Top Debtor —
   `monthlyDigestService.js`.
2. Sent as a WhatsApp interactive `cta_url` message with a tappable
   **"View Full Report"** button.
3. Tapping it opens a hosted HTML page (`fullReportService.js` +
   `reports.routes.js`) showing Total Revenue / Outstanding / Net
   Cashflow cards, a Weekly Revenue bar chart, an Outstanding Debts list
   with per-debtor progress bars, Top Products This Month, and a
   rule-based **Kika AI Insight** (revenue trend, product concentration,
   and a persistent-top-debtor callout when the same customer has led
   the debt list for multiple consecutive months).
4. The report is a **snapshot**, not a live query — stored in
   `monthly_reports` so the page a merchant opens days later still
   matches what the digest told them.
5. Standard and Free merchants still get the plain-text Monthly Insights
   summary automatically; they just don't get the card + full report.

### 8. Tiered pricing
Two flat tiers, matching the pricing page:
- **Standard** — NGN 5,000
- **Premium** — NGN 10,000 (unlocks the Monthly Digest + loyalty flags)

Texting `UPGRADE` presents both as tappable WhatsApp reply buttons;
texting `STANDARD` or `PREMIUM` directly (or tapping a button) goes
straight to that tier's Paystack checkout link. The webhook reads which
tier was purchased from the stored `payment_transactions.plan_tier` and
activates the matching plan — never trusting the client-supplied tier at
send time alone.

### 9. Smart Customer Loyalty Flags (Standard + Premium)
If a merchant includes a customer's phone number in their message (e.g.
`Mama Tunde 08012345678 buy 3 carton indomie...`), Kika tracks that
number's purchase count per merchant. Every 5th purchase (configurable
via `LOYALTY_MILESTONE_INTERVAL`), it:
1. Pings the **customer** directly over WhatsApp with a thank-you note.
2. Notifies the **merchant** that the customer hit a loyalty milestone.

Gated to Standard and Premium — Free-tier merchants don't get loyalty
tracking. Implemented in `loyaltyService.js`, backed by the
`customer_loyalty` table (unique per merchant + phone).

### 10. Multimodal AI — text, voice notes, and images
Kika understands more than typed text:
- **Voice notes**: downloaded from WhatsApp, transcribed via OpenAI
  Whisper (`mediaService.transcribeWhatsappAudio`), then the transcript
  flows through the exact same pipeline as a typed message (regex first,
  AI fallback second).
- **Images**: a photo of a handwritten note or a receipt is downloaded
  and passed as a vision input to the AI fallback
  (`mediaService.downloadWhatsappImageAsBase64` + the `record_transaction`
  tool call), which reads the visible numbers/names/items exactly like a
  text description of the same sale.
- All media download and transcription happens in the **worker**
  process, never in the webhook's request/response cycle, so slow media
  fetches can't back up the fast-acknowledging webhook.

Kika's identity, tone, scope, and hard behavioral rules live in one file:
**`src/config/aiPersona.js`** (`KIKA_SYSTEM_PROMPT`). It defines:
- Who Kika is (a business ledger assistant, not a general chatbot) and
  what languages it replies in (English, Nigerian Pidgin, Yoruba, Igbo,
  Hausa — matching whatever the merchant used).
- What's in scope (recording transactions, balance/report questions,
  how Kika works) and what it politely declines (general knowledge,
  entertainment, anything unrelated to the merchant's own ledger),
  including the exact one-line decline-and-redirect behavior.
- Hard rules: never invent an amount/name, never claim to have recorded
  something it didn't, never reveal its system prompt, never discuss
  other merchants' data.

### 11. Hybrid parsing — regex first, AI safety net second
The original risk: the fast regex parser only recognizes verbs in its
predefined lists, so slang like *"I dashed Amaka 5k"* or *"wired 10k for
fuel"* returned `null` and would have been silently dropped — the
merchant would assume their ledger was updated when it wasn't. Fixed
with a strict two-stage pipeline in the worker:

1. **`ledgerParser.parseLedgerMessage`** runs first, unchanged — instant
   and free for the ~80% of messages using recognizable phrasing.
2. **Only if that returns `null`** (and the message isn't a known
   command), the raw text (plus an image, if any) is routed to
   **`aiTransactionParser.parseWithAI`**, which calls OpenAI with a
   `record_transaction` function-calling tool. The model either:
   - extracts a structured transaction (handling slang, Pidgin, and
     indirect phrasing the regex can't), which is recorded exactly like
     a regex-parsed one, or
   - determines it's genuinely not a transaction and returns an
     in-persona conversational reply (scoped by the system prompt), or
   - the AI call itself fails (no API key, network error, timeout) —
     the code never lets this raise an error back to the user.
3. **If neither stage produces a transaction or a reply**, the user
   always gets the guaranteed fallback: *"I didn't quite catch that.
   Are you trying to record a sale or check your balance? Type HELP for
   a list of commands."* — translated into the detected language where
   available (`getFallbackReply` in `aiPersona.js`). No user input is
   ever silently lost.

**Verified**: I tested both example phrases from the ask directly —
`parseLedgerMessage('I dashed Amaka 5k')` and
`parseLedgerMessage('wired 10k for fuel')` both correctly return `null`
from the regex parser (confirming the gap is real), and a mocked AI
response correctly normalizes into the same kobo-based structure the
regex parser produces. I could not make a live call to `api.openai.com`
in this sandbox (no network egress to that domain), so the OpenAI
integration itself needs a live smoke test in your environment — but the
surrounding hybrid-routing logic, the "no API key configured" safe
fallback, and the normalization/kobo-conversion logic are all verified.

### 12. Access control — blacklist, whitelist, and human handoff
- **Blacklist**: a number in `access_control_list` (list_type=`BLACKLIST`)
  never reaches the bot — the message is still visible in `audit_logs`
  (action `whatsapp.message.blocked`), just never processed or replied to.
- **Whitelist mode**: set `WHITELIST_MODE_ENABLED=true` to restrict the
  bot to only explicitly whitelisted numbers (useful for a closed beta).
  Off by default.
- **Label-based human handoff**: if a merchant's conversation has an
  active label matching `SKIP_BOT_LABELS` (e.g. a support agent tags it
  "Escalated" via the admin API), the bot logs inbound messages but does
  not auto-reply, leaving the human agent in control until the label is
  removed.
- Managed via the admin API (`src/routes/admin.routes.js`, gated by an
  `X-Admin-Key` header matching `ADMIN_API_KEY`) — verified end-to-end
  against a real Postgres instance and over real HTTP requests
  (blacklist/whitelist/label toggling, and the 401 rejection when the
  admin key is missing or wrong).

### 13. Payment links — customer invoices sent inside WhatsApp
Beyond subscription upgrades, a merchant can text **`INVOICE 5000 for
rice`** (or **`INVOICE 08012345678 5000 rice delivery`** to attach a
specific customer) to generate a real, trackable payment link:
1. `paystackService.createCustomerInvoice` initializes a Paystack
   transaction for that amount.
2. `linkShortenerService` wraps the long Paystack checkout URL in a
   compact, unguessable short link (`/l/:code`) and stores it in
   **`payment_links`** (gateway, short_url, status, expiry, customer
   info) — the merchant forwards this short link to their customer.
3. When the customer pays, the Paystack webhook verifies it server-side,
   marks the link `PAID`, and **automatically records a CREDIT ledger
   entry** for the sale — the merchant's books update themselves.
4. A `expireOverduePaymentLinks()` sweep marks stale `PENDING` links
   `EXPIRED`; the redirect route also lazily expires-on-access.

Every call to Paystack (subscription upgrades, customer invoices,
verification) is logged to **`payment_gateway_logs`** — gateway, event
type, reference, request/response payloads, and success/failure — for
reconciliation and support debugging, distinct from the current-state
tables (`payment_transactions`, `payment_links`).

### 14. Disputes and audit logging
- **`DISPUTE <reason>`** lets a merchant flag that a ledger balance
  looks wrong. Logged to **`ledger_disputes`** (reason, status, linked
  ledger entry, resolution notes) and resolvable via the admin API,
  which records any compensating `adjustment_amount_kobo`.
- **`audit_logs`** captures every inbound HTTP request (endpoint,
  method, status code, actor, request id, IP, duration) via the
  `auditLogger` middleware — fire-and-forget, so a logging hiccup can
  never fail a real request — plus explicit business events (blacklist
  changes, dispute resolutions, payment link creation, parsed-vs-AI
  ledger entries, blocked messages) via `auditLogService.logEvent`.

### 15. Onboarding & consent (gates everything else)
A merchant can only log entries once they've accepted terms **and**
provided a business name — existing merchants (already `ACTIVE`+) skip
straight past this on every future message.

1. **First contact** — any message from a brand-new number gets the
   Kika-Book welcome + consent prompt (`whatsappService.sendConsentPrompt`),
   with a single "I AGREE" quick-reply button. (WhatsApp's `button` type
   can't mix a URL button in with quick-replies — so the Terms link is
   plain text in the body, which WhatsApp auto-links, alongside the
   button; both asks from the original spec are satisfied within the
   platform's real constraints.) State: `PENDING_CONSENT`.
2. **Not accepted?** Up to 3 total prompts are sent (tracked via
   `consent_prompt_count`); after the 3rd with no accept, Kika sends one
   polite decline and goes silent (`CONSENT_DECLINED`) — no further
   auto-replies unless the merchant re-engages with a greeting ("Hi",
   "Hello", "Start"...), which resets the flow from scratch.
3. **Accepted** — `consent_at` recorded, state moves to
   `AWAITING_BUSINESS_NAME`, Kika asks for the shop name.
4. **Business name provided** — saved, state moves to `ACTIVE`, and
   *only now* does the merchant unlock ledger recording, commands, etc.

**Verified end-to-end**, not just at the query layer: real BullMQ jobs
pushed through the actual worker (mocked WhatsApp send, real Postgres +
Redis) confirmed the full conversation — first contact → consent →
business name → a real sale getting recorded — all transition correctly,
and that an already-`ACTIVE` merchant re-contacting Kika never gets
routed back through onboarding.

### 16. Currency slang & Nigerian greetings
- **Money shorthand**: `5k`/`5 thousand`, `2m`/`2 million`, `5h`/`5
  hundred` all resolve correctly, on top of the existing comma/decimal
  handling (`100,000`, `1,000,000`) — see `MONEY_SUFFIX_MULTIPLIER` in
  `ledgerParser.js`. Boundary-anchored regex, so `"5 heavy bags"` or
  `"2 mangoes"` never get misread as `500` or `2,000,000`.
- **Greetings** ("Hi", "Hey", "Hello", "Howfar", "Wassup", "Hi Kika"...)
  are matched deterministically (`GREETING` command, zero AI cost) and
  get a fixed in-persona intro — never routed through the AI fallback.

### 17. AI provider flexibility — Gemini, OpenRouter, or OpenAI
`openaiService.js` resolves providers in order: **`GEMINI_API_KEY`** (if
set, routes through Gemini's OpenAI-compatible endpoint, model defaults
to `gemini-1.5-flash` — the current deployment target) → **`OPENAI_BASE_URL`**
+ `OPENAI_API_KEY` (any other OpenAI-compatible proxy, e.g. OpenRouter) →
plain OpenAI directly. **Neither Gemini nor OpenRouter proxy audio
transcription** — only chat completions — so voice notes need a real
OpenAI key configured separately via `OPENAI_TRANSCRIBE_API_KEY` if
you're on either of those providers; the service logs a clear warning
rather than failing silently.

The system prompt (`aiPersona.js`) follows a strict **"tool is king, but
only when earned"** rule: the AI calls `record_transaction` only when it
has a confident entry type, amount, and description; if a message is
transaction-shaped but missing a detail (*"I sold rice today"*), it
returns a short in-persona clarifying question instead of guessing —
*"Nice one! How much you sell the rice for?"* — rather than either
inventing a number or bailing out to the generic fallback. Three
distinct reply paths are separated on purpose:
- **AI extracted a transaction** → recorded normally.
- **AI understood but something's missing/off-topic** → its own
  conversational reply is forwarded verbatim.
- **The AI call itself failed** (timeout, provider outage) → a distinct
  hardcoded message (`AI_ERROR_FALLBACK_REPLY`) — never the generic
  "didn't catch that" text, since this is a different failure mode and
  deserves different wording. A merchant is never left on read.

### 18. Inventory & low-stock alerts
Opt-in, per product: `ADD STOCK: rice, 50` registers/tops up a product
in **`products`**. Any sale mentioning a matching item name
(case-insensitive) decrements `current_stock`; crossing at or below
`low_stock_threshold` (default 5) appends a Low Stock Alert right after
that sale's receipt. **Verified**: a real sale through the worker
correctly took stock from 10 → 2 units and fired the alert in the same
job — caught and fixed a real regex bug along the way (see below).

### 19. Business logo & Premium logbook scanning
- After a successful Premium/Standard payment, Kika opens a 10-minute
  window (`awaiting_logo_until`) where the next image sent is saved as
  the merchant's logo (`mediaService.saveWhatsappImageAsMerchantLogo`)
  instead of being parsed as a transaction — it's then embedded directly
  into every receipt (`receiptService.js`), which shifts the "KIKA
  RECEIPT" wordmark left to make room rather than replacing it.
- **Premium logbook photo scan**: any other image from a Premium
  merchant goes through a *batch* OCR pipeline (`parseMultiTransactionImage`)
  that extracts every visible line as a separate transaction in one AI
  call, records them all, and replies with a summary + `REVIEW SCAN` to
  see the itemized breakdown (cached in Redis for 1h). Non-Premium
  merchants still get the existing single-transaction image fallback.

### 20. Subscription expiry & Friday Debt Amnesty
- A 15-minute sweep (`subscription-expiry-tick`) finds merchants whose
  paid plan has lapsed, downgrades them to Free, and sends the
  "what changes now" notice — **verified** end-to-end against real
  Postgres (forced an expiry into the past, ran the sweep, confirmed the
  downgrade and the notification).
- Every Friday afternoon, merchants with outstanding debt get an opt-in
  prompt (`sendFridayAmnestyPrompt`) — tapping "Send Reminders" messages
  only debtors we actually have a phone number for with one polite,
  pre-written line; "Not Now" just... does nothing. Never automatic.

## Safety & reliability properties

- **SQL injection**: every query in the codebase is parameterized
  (`$1, $2, ...`) via `pg`; `src/db/queries.js` is the single place SQL
  text is written, so the entire attack surface is auditable in one file.
- **Rolling debt balance concurrency**: every debt-affecting write locks
  a per-customer `customer_balances` row with `SELECT ... FOR UPDATE`
  inside a strict `BEGIN`/`COMMIT` transaction before computing a new
  balance — see "Rolling debt balance — race-condition safety" above.
  Verified with a real concurrent-transaction test, not just code review.
- **Webhook authenticity**: both WhatsApp and Paystack webhooks are
  verified with a timing-safe HMAC comparison over the *raw* request
  body before anything is processed.
- **Idempotency — Redis-based, durable**: every inbound WhatsApp message
  id is gated by an explicit Redis lock (`idempotencyService.acquireMessageLock`,
  atomic `SET ... NX EX`) *before* any other work happens — merchant
  lookup, access control, and enqueueing all happen only for the first
  delivery of a given message id. This is deliberately separate from (and
  more durable than) BullMQ's own jobId-based dedup: we bound BullMQ's
  completed-job retention (`removeOnComplete: { age: 3600, count: 1000 }`)
  to keep Redis memory in check, which means a sufficiently late Meta
  retry could outlive that window and BullMQ would treat it as new. The
  explicit lock uses a 48-hour TTL (`MESSAGE_IDEMPOTENCY_TTL_SECONDS`) —
  comfortably longer than any retry window — as the authoritative guard,
  with BullMQ's dedup as a secondary layer. **Verified**, not just
  reasoned about: a real 3-way simultaneous race (`Promise.all`) for the
  same message id against live Redis resolved to exactly one winner, and
  the same message id delivered twice through the actual webhook route
  (valid HMAC signature, full Express app, real Postgres+Redis) produced
  exactly one `audit_logs` entry — the second delivery never reached
  merchant lookup or the queue at all. Paystack references remain
  protected the same way they always were: unique DB constraints plus an
  idempotent status check before any subscription/ledger mutation.
- **Connection pooling**: a single tuned `pg.Pool` (configurable `max`,
  `idleTimeoutMillis`, `connectionTimeoutMillis`, server-side
  `statement_timeout`) backs all queries; every handler is async and
  releases its client in a `finally` block, so a slow query can't hold a
  connection indefinitely and starve concurrent requests.
- **Receipt URLs**: served by a 24-byte random token, never a database
  ID or raw filesystem path, with `path.basename` + prefix-check
  defense-in-depth against traversal.
- **Storage lifecycle — bounded disk usage without breaking promised
  URL lifetimes**: receipt and Monthly Digest card PNGs are written to
  local disk (`RECEIPT_STORAGE_DIR`) with a documented `expires_at` on
  their DB row (from `RECEIPT_URL_TTL_HOURS`, default 72h — long enough
  to cover WhatsApp's own media fetch plus anyone tapping "View Full
  Report" days later). A scheduled sweep (`diskCleanupService.pruneExpiredAssets`,
  registered in `scheduler.js`, running every 15 minutes via
  `STORAGE_CLEANUP_CRON`) deletes a file **only after its own row's
  `expires_at` has already passed** — never on a flat fixed age — so
  disk usage stays bounded under volume without ever invalidating a URL
  before the lifetime already promised to whoever holds it. Each row is
  marked `file_deleted_at` once cleaned so repeat sweeps stay cheap
  regardless of table size, and the serving routes degrade to a clean
  `410` (instead of crashing) if a DB row and its on-disk file ever drift
  out of sync. **Verified**: a real sweep against Postgres + the
  filesystem confirmed an expired file gets deleted while a file 71 hours
  from expiry is left completely untouched, re-running the sweep is a
  clean no-op, and a deliberately-missing-file case returns `410` rather
  than a 500.
- **Rate limiting**: per-endpoint limits on both public webhook routes
  and the receipt-fetch route.

## Deployment — Cloud (Render + Neon + Upstash) or Docker

Kika runs identically in either environment — only how it connects to
Postgres and Redis differs, and that's auto-detected (see
`src/config/db.js` and `src/config/redis.js`):

### Cloud (current deployment target)
1. Provision a [Neon](https://neon.tech) Postgres database and an
   [Upstash](https://upstash.com) Redis database.
2. On [Render](https://render.com), create a **Web Service** (the API,
   `node src/server.js`) and a **Background Worker** (`node src/queue/worker.js`)
   from the same repo/image.
3. Set environment variables on both services — `DATABASE_URL` (Neon's
   pooled connection string, includes `sslmode=require`) and `REDIS_URL`
   (Upstash's `rediss://` URL) are the two that matter most; see
   `.env.example` for the full list.
4. Run the migration once against the Neon database:
   ```bash
   DATABASE_URL="<your neon connection string>" node src/db/migrate.js
   ```
5. Deploy. `db.js` logs `mode: "cloud (DATABASE_URL)"` on startup —
   check the Render logs to confirm it picked up the right path.

### Docker (self-hosted alternative)
```bash
cp .env.example .env
# In .env: comment out DATABASE_URL and REDIS_URL, uncomment the
# PGHOST/PGPORT/... and REDIS_URL=redis://redis:6379 lines instead
# (both are pre-written in .env.example, just swapped in/out).
docker compose up --build
docker compose exec api node src/db/migrate.js
```
This starts Postgres, Redis, the API, and 2 worker replicas locally —
useful for development or a fully self-hosted deployment.

### Running without Docker (local Node, either DB target)

```bash
npm install
cp .env.example .env        # point DATABASE_URL/REDIS_URL at cloud or local
npm run migrate               # applies schema.sql
npm run dev                    # API on :8080
npm run worker                  # in a second terminal
```

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Cloud Postgres connection string (Neon). Unset → falls back to `PGHOST`/`PGPORT`/etc. for Docker. |
| `REDIS_URL` | Redis connection string — `rediss://...` (Upstash, TLS) or `redis://...` (Docker/local) |
| `PG_POOL_MAX` | Max concurrent Postgres connections in the pool |
| `WHATSAPP_APP_SECRET` | Used to verify inbound webhook signatures |
| `PAYSTACK_SECRET_KEY` | Used both to call Paystack and verify its webhooks |
| `SUBSCRIPTION_DURATION_DAYS` | Defaults to `30`, applies to every tier |
| `LOYALTY_MILESTONE_INTERVAL` | Defaults to `5` — ping every Nth purchase |
| `OPENAI_API_KEY` | Required for the hybrid AI fallback parser and multimodal (image/audio) support. Without it, unparseable messages get the fixed fallback reply instead of crashing. |
| `OPENAI_BASE_URL` | Unset = OpenAI direct. Set to `https://openrouter.ai/api/v1` to route through OpenRouter instead (note: Whisper transcription isn't proxied by OpenRouter — see `.env.example`). |
| `AI_MIN_CONFIDENCE_THRESHOLD` | Defaults to `0.65` — below this, an AI-extracted transaction is treated as unclear rather than recorded |
| `SKIP_BOT_LABELS` | Comma-separated conversation labels that pause the bot for human handoff |
| `WHITELIST_MODE_ENABLED` | `true` restricts the bot to explicitly whitelisted numbers only |
| `ADMIN_API_KEY` | Shared secret for the admin endpoints (`X-Admin-Key` header) |
| `MESSAGE_IDEMPOTENCY_TTL_SECONDS` | Defaults to `172800` (48h) — how long the Redis dedup lock on a WhatsApp message id lasts |
| `STORAGE_CLEANUP_CRON` | Defaults to every 15 minutes — sweep cadence for pruning expired receipt/digest card files |
| `BROKER_ALERT_WEBHOOK_URL` | Optional external automation sink for the victory alert |

Tier pricing itself is **not** an env var — it lives in the
`subscription_tiers` table (see below) so it can change without a
redeploy.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Liveness/readiness probe |
| GET/POST | `/api/v1/webhook` | WhatsApp Cloud API webhook (verify + intake) |
| POST | `/api/v1/payments/paystack/webhook` | Paystack payment webhook |
| GET | `/api/v1/receipts/:token.png` | Serves a generated receipt card |
| GET | `/api/v1/digest-cards/:token.png` | Serves a generated Monthly Digest card |
| GET | `/api/v1/reports/:token` | Serves the full Monthly Report web page |
| GET | `/api/v1/pricing` | Public list of active subscription tiers |
| GET | `/api/v1/exports/:token.csv` | Serves a CSV ledger export (via the `EXPORT` command) |
| GET | `/l/:code` | Resolves a short payment link and redirects to the gateway checkout |
| POST/DELETE | `/api/v1/admin/access-control/*` | Blacklist/whitelist management (requires `X-Admin-Key`) |
| POST/DELETE | `/api/v1/admin/merchants/:id/labels*` | Conversation label management (requires `X-Admin-Key`) |
| POST/GET | `/api/v1/admin/disputes/*` | Dispute resolution (requires `X-Admin-Key`) |

## Chat commands

| Command | Behavior |
|---|---|
| *(free text, voice note, or photo)* | Parsed as a ledger entry — regex first, AI fallback second |
| *(greeting: "Hi", "Hello", "Howfar"...)* | Deterministic in-persona intro, no AI call |
| `BALANCE` | Live in/out/net + outstanding debt snapshot |
| `SUNSET` | Today's recap, on demand |
| `INSIGHTS` | This month's trends, on demand (text summary) |
| `UPGRADE` | Shows tier features + tappable plan-selection buttons |
| `STANDARD` / `PREMIUM` | Sends that tier's Paystack checkout link |
| `INVOICE <amount> [description]` | Generates a trackable customer payment link |
| `DISPUTE <reason>` | Flags a ledger balance issue for review |
| `UNDO` | Voids the most recent entry (not available for debt settlements) |
| `ADD STOCK: <item>, <qty>` | Registers/tops up inventory for a product |
| `CLOSING HOUR <hour>` | Sets this merchant's personal Business Sunset time |
| `EXPORT` | Emails a CSV ledger export (Standard/Premium only) |
| `REVIEW SCAN` | Shows the itemized breakdown of the last logbook photo scan |
| `HELP` | Usage examples |

## Testing notes

This codebase has been exercised against real, freshly-migrated Postgres
and Redis instances (not just mocks) — including real HTTP requests
against a running Express server, not just direct function calls:
merchant creation, pidgin-English parsing, phone number extraction, FIFO
debt settlement, tier upgrades, loyalty milestones, the Monthly Digest +
full report, and the `subscription_tiers` foreign keys were all verified
in earlier passes (see git history / prior notes). This pass additionally verified:
- The hybrid parser gap is real: both `"I dashed Amaka 5k"` and `"wired
  10k for fuel"` confirmed to return `null` from the regex parser, and a
  mocked AI response correctly normalizes into the same kobo-based
  structure — including the "no `OPENAI_API_KEY` configured" safe
  fallback path, which returns cleanly without a network call or a crash.
- Access control end-to-end: blacklist blocks access, whitelist-mode
  correctly gates unlisted numbers, and label-based human handoff
  correctly pauses and resumes the bot — all against real DB state.
- Payment links: short-code generation, resolution, and a real HTTP 302
  redirect to the underlying gateway URL; marking a link `PAID` sets
  `paid_at` correctly (caught and fixed a real Postgres type-inference
  bug in that query along the way).
- Payment gateway activity logging, ledger dispute creation +
  resolution, and audit log writes (including metadata) all confirmed
  via direct DB inspection.
- Admin API: a real HTTP request without `X-Admin-Key` gets `401`; a
  request with the correct key successfully creates a blacklist entry.
- **Caught and fixed a real dependency-version bug**: a `bullmq` minor
  version bump (still satisfying the original `^5.7.8` range) started
  rejecting colons in queue names, which would have crashed the entire
  app on startup. Found by actually booting the full Express app rather
  than only testing modules in isolation — queue names now use hyphens,
  and `bullmq` is pinned to the tested version.

**Not independently verified**: an actual live call to `api.openai.com`
— this sandbox has no network egress to that domain, so the OpenAI
request/response shape (model name, exact function-calling behavior,
Whisper transcription, vision input format) is implemented per the
current OpenAI Node SDK conventions but should get one real smoke test
in your environment before going live.
