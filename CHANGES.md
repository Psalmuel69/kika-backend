# Session changes summary

This document summarizes everything changed in this session, organized by
theme, for review purposes. Nothing here is meant to replace reading the
actual diffs — it's a map, not a substitute.

## -3. Latest round: multi-transaction UX (7 repeated acks, duplicate "Sale" labels)

The database fix in section -2 below worked — all N transactions from
one message are now correctly written to the database. Two follow-on
UX problems surfaced once that was true:

- **Seven near-identical "Noted — log another, or type DONE when
  finished." messages in a row** for one message that split into seven
  transactions — each entry's commit was sending its own ack (a
  deliberate choice for the ORIGINAL use case of several separate
  messages, to preserve per-entry reply-context), but for one message
  splitting into many, this reads as broken, not helpful. Fixed:
  `commitParsedEntry` now takes a `sendAck` flag; the multi-transaction
  commit loop passes `sendAck: false` and instead builds ONE
  consolidated summary ("Found 7 separate transactions in that — logged
  them all: • Sale via transfer — ₦45,000 • ... Log another, or type
  DONE when finished."), sent once. Loyalty milestones and low-stock
  alerts collected across the batch are still surfaced, just after the
  one summary rather than interleaved with per-entry acks.
- **Every transaction with no item/customer mentioned showing up as a
  bare, identical "Sale"** (three separate customer payments all
  labeled "Sale" on the receipt, with no way to tell them apart) — added
  explicit system-prompt guidance: when a payment method is the only
  distinguishing detail given ("₦45,000 transfer, ₦12,000 POS, ₦8,000
  cash"), use it ("Sale via transfer", "Sale via POS", "Sale via cash")
  rather than repeating an identical generic label for genuinely
  different transactions.

## -2. Earlier round: the multi-transaction feature was silently only saving entry #1

The multi-transaction extraction added in the previous round (see
section -1 below) correctly identified every transaction in a message,
said so out loud ("Found 7 separate transactions..."), but only the
FIRST one was ever actually written to the database — the receipt and
the final confirmation both only ever reflected one entry.

Root cause: `ledger_entries` had a plain `UNIQUE` index on
`whatsapp_message_id` alone, built back when "one inbound WhatsApp
message -> at most one ledger entry" was always true (its purpose is to
block a genuine duplicate webhook delivery from double-logging a
transaction). Once one message could legitimately produce several
entries, the second entry's insert violated that constraint and threw —
crashing the whole job. The job queue automatically retried it, and on
retry, the very first check in the pipeline ("has this message already
produced an entry?") found the one entry that succeeded before the
crash and gave up on the entire message, silently, before ever
attempting entries 2 onward again.

Fixed via a new migration
(`src/db/migrations/0002_multi_transaction_message_sequence.sql`):
added a `message_sequence_index` column (0 for an ordinary
single-transaction message, 0..N-1 for a split message) and made the
uniqueness constraint composite — `(whatsapp_message_id,
message_sequence_index)` — so it still fully blocks a genuine duplicate
delivery of the same message while allowing several legitimate entries
from one message. Threaded through `queries.createLedgerEntry` ->
`ledgerService.recordLedgerEntryAndReceipt`/`recordDebtSettlement` ->
`worker.js`'s `commitParsedEntry` and the multi-transaction commit loop.
Also wrapped each individual commit in the multi-transaction loop in
its own try/catch, so a transient failure on ONE transaction can never
crash the whole batch (which would trigger the same
already-partially-exists retry problem for a different reason). Two new
regression tests prove the fix, including one that directly verifies
`createLedgerEntry` receives a distinct sequence index for every entry
in a batch sharing one inbound message.

The Premium logbook-photo-scan feature was checked and confirmed
unaffected — it never sets `whatsapp_message_id` on its entries (they're
NULL, which the unique index explicitly exempts), so it was never
subject to this bug.

## -1. Earlier round: multi-transaction data loss, voice notes, email-collection timing

- **Multi-transaction extraction (severe bug, now fixed)**: a free-form
  message describing SEVERAL distinct transactions (e.g. a whole day
  recapped in one message — several expenses, several sales) was
  silently recording only ONE of them and dropping the rest, with no
  indication anything was missed. Root cause: the AI escalation path
  could only ever call a tool that proposes a single transaction, and
  the system prompt explicitly instructed the model to pick just one
  when several were described. Fixed by:
  - Giving the model a genuine choice between `record_transaction`
    (one) and `record_multiple_transactions` (several) on every text
    message escalation, not just the existing Premium photo-scan
    feature.
  - Rewriting the system prompt section that was actively causing this
    (see `src/config/aiPersona.js`), replacing "a message can only be
    ONE entry type" with explicit guidance on recognizing and splitting
    multiple transactions.
  - `worker.js` now validates and commits every extracted transaction
    independently (same `entryValidator`/currency-gate/`commitParsedEntry`
    machinery as a single entry — no relaxed trust boundary), with a
    clear "Found N transactions, logging them one by one" message and
    honest reporting of anything skipped, never silent data loss.
  - Also fixed the underlying "item name became a fragment of the raw
    sentence" quality bug (e.g. "Just Received" as an item name) via
    explicit system-prompt guidance on description/item-name quality.
  - Two new regression tests reconstruct the exact reported scenarios
    end to end (schema validation → normalization → entryValidator),
    confirming every transaction now survives.
  - Also fixed a stale currency-handling paragraph in the system prompt
    that still described the abandoned live-exchange-rate-conversion
    approach from earlier in this session, instead of the current
    calling-code-based default-currency design.
- **Voice notes gated to Standard/Premium**: checked before the (paid,
  per-call) transcription API is ever invoked — a Free-tier merchant's
  audio now gets a plain upsell message instead of being transcribed.
- **Email-collection nudge timing**: previously fired synchronously,
  immediately after a logging session's receipt Yes/No resolved — no
  pause at all, reading as Kika talking over itself. Now scheduled as a
  genuinely delayed BullMQ job (~1 minute later, on the same queue/
  worker already running), with the actual NPS/email-milestone
  condition re-checked fresh when the delayed job fires rather than
  trusting a stale snapshot from a minute earlier.

## 0. Previous round: reported bugs + Premium gating + AI fallback + help-guide referrals

- **PDF generation bug, root-caused**: `generateInvoicePdf` was working
  correctly the whole time — the actual bug was a missing `.pdf` route in
  `receipts.routes.js` (only `.png` existed), so the generated PDF's URL
  404'd when WhatsApp tried to fetch it. Added the route (shared handler
  with `.png`, since the file on disk always has the real extension
  either way).
- **Invoice column collision, root-caused**: `buildInvoiceSvg`'s
  Qty/Rate/Line-Total columns used a FIXED pixel gap (190px) sized for
  "typical" amounts — a real invoice with wider figures (e.g.
  `$200,000.00`) only had ~5px of actual clearance once glyph widths
  were accounted for, causing the visible collision. Rewrote column
  positioning to compute widths dynamically from each invoice's actual
  content (reusing the file's existing monospace width estimator),
  guaranteeing a real gap regardless of amount size. Covered by two new
  regression tests, including one reconstructing the exact reported
  numbers.
- **Multi-currency logging is now Premium-gated**: both `SET CURRENCY`
  and stating an amount in a currency other than the account's default
  during ordinary logging now require Premium — a non-Premium merchant
  gets a clear upsell message instead of being processed. A Premium
  merchant's entry is recorded directly in the currency they actually
  stated (genuine multi-currency bookkeeping), rather than being asked
  to restate it. Invoices remain free-currency for every tier (they
  don't touch the merchant's own accounting). The logbook-scan pipeline
  (already Premium-only) was updated to match, including fixing its
  "Total Inflows" summary to aggregate per-currency instead of summing
  raw kobo across what could now be different currencies.
- **AI fallback for invoice items**: a free-form invoice-item reply that
  doesn't match the standard "quantity x name x price" template now
  gets one AI extraction attempt (`invoiceItemExtractionService.js`)
  before falling back to "didn't catch that" — the model is explicitly
  instructed to decline rather than guess when a message isn't really
  an item at all, so this never fabricates a line item from an
  unrelated message.
- **"Refer to HELP, don't claim false success"**: the system prompt's
  existing "never claim you recorded something you didn't" rule was
  broadened to cover any action (invoices, stock, settings — not just
  ordinary entries) and now explicitly requires pointing to HELP when
  the model can't confidently tell what the merchant wants, rather than
  guessing at the action. The AI-call-failure fallback message and the
  new invoice-item fallback message both now point to HELP too.

## 1. Multi-country / multi-currency support

- **`src/config/countryCurrency.js`** (new) — an offline, static lookup
  table mapping every country's calling code to its currency (code,
  symbol, name). Generated from the `world-countries` npm package (a
  devDependency only — no runtime cost) via
  **`scripts/generate-country-currency-table.js`**; regenerate with
  `npm run generate:country-currency`. No live exchange-rate API is used
  anywhere — a merchant's currency is a one-time, deterministic lookup
  at signup, not a per-message network call.
- **`src/db/queries.js`** — `findOrCreateMerchantByWhatsappNumber` now
  resolves `default_currency` from the merchant's WhatsApp number at
  signup. New `setMerchantCurrency` lets a merchant correct it later.
- **`SET CURRENCY <CODE>`** command (`ledgerParser.js` / `worker.js`) —
  since the phone-code guess is a heuristic, not ground truth, a
  merchant can explicitly override it (e.g. `SET CURRENCY GHS`).
- **Ledger entries**: if a merchant states an amount in a currency other
  than their account's currency (e.g. "$500" on an NGN account), Kika
  asks them to clarify/restate rather than auto-converting — this
  applies to both the main message pipeline and the logbook-photo scan
  pipeline.
- **Invoices**: allowed to be in ANY currency freely (an invoice is a
  document handed to a customer, not part of the merchant's own
  accounting) — no clarification needed, unlike ledger entries.
- **Currency detection** (`ledgerParser.js`, `extractionSchema.js`,
  `aiTransactionParser.js`, `aiPersona.js`): both the regex parser and
  the AI path now tag an EXPLICIT stated currency (NGN/USD/GBP/EUR) or
  `null` for "unspecified — assume the merchant's own account currency."
  This distinction (null vs. NGN-as-default) was the source of a real
  bug caught and fixed mid-session — an earlier version of this same
  session's work defaulted unspecified currency to NGN, which would
  have falsely flagged every AI-parsed entry from a non-Nigerian
  merchant as a mismatch.
- **`src/utils/currency.js`** — rewritten as a generic
  `formatAmount(kobo, currencyCode)` / `formatAmountWithCents(...)`
  (replacing an abandoned live-FX-conversion version built earlier in
  the session and then intentionally reverted in favor of the
  calling-code approach). `formatNaira` kept as a back-compat alias.
- **Receipts, invoices, and reports** (`receiptService.js`,
  `ledgerService.js`, `worker.js`) now format amounts in the merchant's
  own currency instead of a hardcoded ₦, including a real bug fix:
  `amountMarkup`'s font-splitting logic only handled single-character
  currency symbols — 67 of the 153 currencies in the table use
  multi-character symbols ("Sh" for KES/TZS/UGX, "Fr" for XOF/XAF, "R$"
  for BRL, etc.), which were rendering with a font mismatch. Fixed and
  covered by a regression test.
- **International phone numbers**: customer phone validation
  (`entryValidator.js`, `extractionSchema.js`, three spots in
  `ledgerParser.js`) previously only accepted Nigerian (`+234...`)
  numbers — every other country's customer phone was silently dropped
  to `null`, breaking loyalty-milestone tracking for non-Nigerian
  merchants. Generalized to standard E.164 everywhere, keeping the
  Nigerian domestic-shorthand (`0801...`) convenience.

## 2. Invoice flow improvements

- Asks for the customer's phone number before collecting items (new
  `AWAITING_PHONE` stage) when not given upfront, so it can be saved
  against the customer record and shown on the invoice.
- Choice of **Image or PDF** output at confirmation (new
  `generateInvoicePdf` in `receiptService.js`, sharing the same SVG
  source as the image version — a layout fix only ever needs to happen
  once). New `.pdf` route added alongside the existing `.png` route.
- Fixed the invoice's visual layout bug: divider lines were computed to
  land ON the "Tax" and "Total" rows' own text (causing a
  strikethrough-like look), rather than in clear space below them.
  Rewrote the spacing math with explicit clearance constants, and
  pushed the footer divider/watermark down for better breathing room.

## 3. Deterministic command fixes (no AI calls)

- **DISPUTE** with no reason now asks for one instead of logging "No
  reason provided."
- **CLOSING HOUR** with no (valid) hour now asks what time, instead of
  silently falling through.
- **ADD STOCK** missing the item and/or quantity now asks for what's
  missing, instead of silently ignoring the message.

## 4. Onboarding name extraction

- Business name replies like "my business name is Ebuka & Sons Ltd" or
  "Ebuka & Sons Ltd is the name" are now stripped of the surrounding
  sentence before saving (`ledgerParser.extractBusinessNameFromReply`),
  since this name is printed on every future receipt/invoice.
  Deterministic pattern-stripping first (no AI cost); a rare
  unrecognized phrasing falls back to one targeted AI extraction call
  (`nameExtractionService.js`), never blocking onboarding if that fails.

## 5. Conversational logging improvements

- **"Is this also for [name]?"** — a multi-entry logging session where
  a later entry doesn't repeat the customer's name (or uses a pronoun)
  now asks whether it's the same customer as the most recently named
  one in that session, instead of silently treating it as anonymous or
  asking "who owes this?" from scratch.
- Batch confirmation text and the receipt-decision summary now name the
  customer directly when a whole batch shares one ("recorded 3 entries
  for Mama Tunde") instead of a generic count, when applicable.
- **HELP** text trimmed to a single example (Mama Tunde) with a
  one-line description added for every command.

## 6. Engineering process improvements

- **Test suite** (new, `test/`, run via `npm test`): Node's built-in
  test runner (`node:test`, zero new dependencies). 100 tests covering
  the accounting engine's every hard-reject/soft-repair rule, the
  free-text parser's classification/money-math/currency/phone/name
  logic, the country-currency table, and the migrations directory
  convention. Two real, independent bugs were caught and fixed via this
  suite (see sections 1 above).
- **`worker.js` modularization**: extracted the invoice-creation flow
  (`src/queue/invoiceFlow.js`) and the onboarding state machine
  (`src/queue/onboardingFlow.js`) into their own modules — `worker.js`
  went from ~1,900 to ~1,550 lines. Both new modules were independently
  smoke-tested to confirm identical behavior after extraction.
- **Shared "pending question" Redis pattern**
  (`src/services/pendingQuestionStore.js`): the debt-name and
  same-customer flows had near-identical stash/consume/TTL logic,
  copy-pasted once; extracted before a third copy could introduce a
  divergent bug.
- **Versioned schema migrations**: replaced the single
  ever-growing `schema.sql`, re-run in full on every deploy, with
  tracked migrations in `src/db/migrations/` (a `schema_migrations`
  table records what's been applied; `npm run migrate` only runs what's
  new). `0001_baseline.sql` captures the full prior schema as an honest
  starting point. See `src/db/migrations/README.md` for the convention
  going forward. Old `schema.sql` retired to a redirect stub.

## Known, deliberately deferred items

Flagged clearly rather than rushed:

- `monthlyDigestService.js`, `fullReportService.js`, `exportService.js`,
  and `businessContextService.js` still hardcode ₦ — lower-traffic
  surfaces (Premium-only digest, hosted full report, CSV export,
  internal AI context) not yet threaded with the merchant's currency.
- `formatAmount`'s "format to a string, then re-split the string by
  regex to pick a font" design is still fragile in principle, even
  though the concrete bug it caused is fixed and now tested.
- `worker.js` is still large; invoice and onboarding were the two
  cleanest extractions, but the core message-classification pipeline
  and the stock/dispute/closing-hour commands remain in the main file.
- No labeled evaluation set exists for the regex-vs-AI confidence
  thresholds — they're reasoned-about, not measured against real
  merchant message data.
- Phone number *detection* in free text (as opposed to *validation*,
  which is now international) is still closest to Nigerian shorthand
  patterns for the bare-digit case; an explicit "+"-prefixed number
  from any country is recognized, but a bare local-format number from a
  country other than Nigeria (e.g. Ghana's own "0" + 9-digit shorthand)
  is not specifically pattern-matched.
- Free-form AI fallback currently covers invoice items specifically
  (see section 0 above) and ordinary ledger entries (which already had
  AI escalation before this session). It has not been extended to
  every other structured command (ADD STOCK, CLOSING HOUR, etc.) — those
  still ask the merchant to retry in the stated format rather than
  attempting an AI-assisted extraction.
- The multi-transaction extraction path (see section -1 above) has no
  per-transaction confidence gate — it inherits the same trust boundary
  as the existing Premium logbook-scan feature (schema validation +
  entryValidator, no confidence score to threshold against), rather
  than the single-transaction path's explicit confidence check. Worth
  revisiting if false-positive transaction splitting turns out to be a
  real problem in practice.
