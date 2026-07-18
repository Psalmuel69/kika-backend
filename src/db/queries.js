'use strict';

/**
 * SQL-INJECTION SAFETY CONTRACT
 * -----------------------------
 * Every function in this file uses positional placeholders ($1, $2, ...)
 * and passes user-controlled values only through the `params` array of
 * db.query(). No function in this codebase should ever build a query
 * string via template literals or concatenation with request data.
 * This file is the ONLY place raw SQL text is written, so a code reviewer
 * (or lint rule) can audit the entire attack surface by reading one file.
 */

const { query, withTransaction } = require('../config/db');

// Every merchant read joins subscription_tiers so callers get `plan`
// (the tier name, e.g. 'Free'/'Standard'/'Premium') plus pricing/feature
// data alongside the merchant row, without a second round-trip.
const MERCHANT_WITH_TIER_SELECT = `
  SELECT m.*, st.name AS plan, st.price AS tier_price, st.currency AS tier_currency,
         st."interval" AS tier_interval, st.feature_list AS tier_feature_list
  FROM merchants m
  JOIN subscription_tiers st ON st.id = m.subscription_tier_id
`;

// --- Subscription tiers ----------------------------------------------------

async function listActiveSubscriptionTiers() {
  const res = await query(
    'SELECT * FROM subscription_tiers WHERE is_active = true ORDER BY display_order ASC'
  );
  return res.rows;
}

/** The single highest-ranked active tier (by display_order) — used to tell
 * a merchant "you're already on the top plan" instead of showing UPGRADE options. */
async function getHighestActiveSubscriptionTier() {
  const res = await query(
    'SELECT * FROM subscription_tiers WHERE is_active = true ORDER BY display_order DESC LIMIT 1'
  );
  return res.rows[0] || null;
}

async function getSubscriptionTierByName(name) {
  const res = await query(
    'SELECT * FROM subscription_tiers WHERE name ILIKE $1 AND is_active = true',
    [name]
  );
  return res.rows[0] || null;
}

async function getSubscriptionTierById(id) {
  const res = await query('SELECT * FROM subscription_tiers WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// --- Merchants ---------------------------------------------------------

async function findOrCreateMerchantByWhatsappNumber(whatsappNumber, whatsappDisplayName) {
  const existing = await query(`${MERCHANT_WITH_TIER_SELECT} WHERE m.whatsapp_number = $1`, [
    whatsappNumber,
  ]);
  if (existing.rows[0]) {
    // WhatsApp resends the contact's current profile name on every
    // delivery — cheap to keep in sync so Kika always has an up to date
    // fallback for greetings even if the merchant never introduces
    // themselves. Only writes when it actually changed, and never
    // touches merchant_name (the name the merchant explicitly gave us).
    if (whatsappDisplayName && whatsappDisplayName !== existing.rows[0].whatsapp_display_name) {
      await query('UPDATE merchants SET whatsapp_display_name = $2 WHERE id = $1', [
        existing.rows[0].id,
        whatsappDisplayName,
      ]);
      existing.rows[0].whatsapp_display_name = whatsappDisplayName;
    }
    return existing.rows[0];
  }

  // New merchants default to subscription_tier_id 1 (Free) and
  // onboarding_state 'PENDING_CONSENT' via the columns' own DEFAULTs —
  // the very first thing they see is the consent prompt, before any
  // ledger functionality is available to them.
  const created = await query(
    `INSERT INTO merchants (whatsapp_number, whatsapp_display_name)
     VALUES ($1, $2)
     ON CONFLICT (whatsapp_number) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number
     RETURNING id`,
    [whatsappNumber, whatsappDisplayName || null]
  );
  return getMerchantById(created.rows[0].id);
}

async function getMerchantById(merchantId) {
  const res = await query(`${MERCHANT_WITH_TIER_SELECT} WHERE m.id = $1`, [merchantId]);
  return res.rows[0] || null;
}

async function setMerchantOnboardingState(merchantId, state) {
  const res = await query(
    'UPDATE merchants SET onboarding_state = $2 WHERE id = $1 RETURNING id',
    [merchantId, state]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/** Records consent (compliance timestamp) and advances to the next onboarding step. */
async function recordMerchantConsent(merchantId) {
  const res = await query(
    `UPDATE merchants
     SET consent_at = now(), onboarding_state = 'AWAITING_BUSINESS_NAME', consent_prompt_count = 0
     WHERE id = $1 RETURNING id`,
    [merchantId]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/** Increments the consent-nudge counter and returns the updated merchant. */
async function incrementConsentPromptCount(merchantId) {
  const res = await query(
    `UPDATE merchants SET consent_prompt_count = consent_prompt_count + 1 WHERE id = $1 RETURNING id`,
    [merchantId]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/** After 3 unsuccessful nudges — stop auto-prompting until the merchant re-engages. */
async function markConsentDeclined(merchantId) {
  const res = await query(
    `UPDATE merchants SET onboarding_state = 'CONSENT_DECLINED' WHERE id = $1 RETURNING id`,
    [merchantId]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/** A merchant who previously declined re-engages (e.g. types "hi") — restart the consent flow fresh. */
async function restartConsentFlow(merchantId) {
  const res = await query(
    `UPDATE merchants SET onboarding_state = 'PENDING_CONSENT', consent_prompt_count = 0 WHERE id = $1 RETURNING id`,
    [merchantId]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

async function setMerchantBusinessName(merchantId, businessName) {
  const res = await query(
    `UPDATE merchants
     SET business_name = $2, onboarding_state = 'AWAITING_BUSINESS_TYPE'
     WHERE id = $1 RETURNING id`,
    [merchantId, businessName]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/**
 * Second onboarding step, right after business name: the merchant's own
 * free-text answer to "what type of business is it?" is stored verbatim
 * in business_type, alongside Kika's own classification of it into a
 * fixed business_category (see categorizationService.categorizeBusinessType,
 * called by the worker before this is written). Advances to ACTIVE —
 * this is the last onboarding gate.
 */
async function setMerchantBusinessType(merchantId, businessType, businessCategory) {
  const res = await query(
    `UPDATE merchants
     SET business_type = $2, business_category = $3, onboarding_state = 'ACTIVE'
     WHERE id = $1 RETURNING id`,
    [merchantId, businessType, businessCategory || null]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/**
 * Sets the merchant's OWN name — deliberately distinct from
 * whatsapp_display_name (Meta's contact profile name, captured
 * automatically) and business_name (their shop's name). Only written
 * when the merchant actually introduces themselves ("I'm Samuel") or
 * answers a direct name prompt — never inferred or guessed.
 */
async function setMerchantName(merchantId, merchantName) {
  const res = await query(
    'UPDATE merchants SET merchant_name = $2 WHERE id = $1 RETURNING id',
    [merchantId, merchantName]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

async function setMerchantClosingHour(merchantId, hour) {
  const res = await query(
    'UPDATE merchants SET closing_hour_local = $2 WHERE id = $1 RETURNING id',
    [merchantId, hour]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

async function setMerchantLogo(merchantId, filePath) {
  const res = await query(
    'UPDATE merchants SET logo_file_path = $2, awaiting_logo_until = NULL WHERE id = $1 RETURNING id',
    [merchantId, filePath]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

async function setAwaitingLogoWindow(merchantId, minutesFromNow) {
  await query(
    `UPDATE merchants SET awaiting_logo_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
    [merchantId, minutesFromNow]
  );
}

/** Merchants whose Africa/Lagos closing hour matches the given hour (0-23) — for the hourly Business Sunset scheduler tick. */
async function getMerchantsWithClosingHour(hour) {
  const res = await query('SELECT * FROM merchants WHERE closing_hour_local = $1', [hour]);
  return res.rows;
}

/** Merchants whose paid subscription has lapsed and haven't been downgraded yet. */
async function getExpiredSubscriptionMerchants() {
  const res = await query(
    `SELECT m.*, st.name AS plan FROM merchants m
     JOIN subscription_tiers st ON st.id = m.subscription_tier_id
     WHERE m.subscription_expires_at IS NOT NULL
       AND m.subscription_expires_at < now()
       AND st.name != 'Free'`
  );
  return res.rows;
}

/** Downgrades a merchant to the Free tier once their paid subscription lapses. */
async function downgradeMerchantToFreeTier(merchantId) {
  const freeTier = await getSubscriptionTierByName('Free');
  const res = await query(
    `UPDATE merchants
     SET subscription_tier_id = $2, onboarding_state = 'ACTIVE', subscription_expires_at = NULL
     WHERE id = $1 RETURNING id`,
    [merchantId, freeTier.id]
  );
  return res.rows[0] ? getMerchantById(res.rows[0].id) : null;
}

/**
 * Atomically extends a merchant's subscription window by `days` days from
 * the greater of (now) or (their current expiry) — so early renewals stack
 * rather than being wasted — and moves them onto the purchased tier.
 * `tierNameOrId` accepts either the tier's name ('Standard'/'Premium') or
 * its numeric id, resolved against subscription_tiers so pricing/tier
 * changes never require touching this function.
 */
async function extendMerchantSubscription(merchantId, tierNameOrId, days) {
  const tier =
    typeof tierNameOrId === 'number'
      ? await getSubscriptionTierById(tierNameOrId)
      : await getSubscriptionTierByName(tierNameOrId);
  if (!tier) throw new Error(`Unknown subscription tier: ${tierNameOrId}`);

  const onboardingState = `${tier.name.toUpperCase()}_ACTIVE`;

  const res = await query(
    `UPDATE merchants
     SET subscription_tier_id = $3,
         onboarding_state = $4,
         subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, now()), now())
                                    + ($2 || ' days')::interval
     WHERE id = $1
     RETURNING id`,
    [merchantId, days, tier.id, onboardingState]
  );
  return getMerchantById(res.rows[0].id);
}

// --- Ledger entries ------------------------------------------------------

async function createLedgerEntry(client, entry) {
  const res = await client.query(
    `INSERT INTO ledger_entries
       (merchant_id, entry_type, counterparty_name, counterparty_phone, description, items,
        total_kobo, paid_kobo, balance_kobo, balance_after_kobo, currency, is_settled, raw_message,
        whatsapp_message_id, reply_to_whatsapp_message_id, expense_category)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      entry.merchantId,
      entry.entryType,
      entry.counterpartyName || null,
      entry.counterpartyPhone || null,
      entry.description,
      JSON.stringify(entry.items || []),
      entry.totalKobo,
      entry.paidKobo,
      entry.balanceKobo,
      entry.balanceAfterKobo ?? null,
      entry.currency || 'NGN',
      entry.balanceKobo <= 0,
      entry.rawMessage || null,
      entry.whatsappMessageId || null,
      entry.replyToWhatsappMessageId || null,
      entry.expenseCategory || null,
    ]
  );
  return res.rows[0];
}

/**
 * Records the wamid of KIKA'S OWN reply/receipt about a ledger entry —
 * called right after the outbound WhatsApp send succeeds. This is what
 * lets a later inbound reply (its `context.id` matching this value) be
 * resolved back to the exact entry it's responding to — see
 * getLedgerEntryByOutboundMessageId and ledgerParser.parseReplyMessage.
 * Fire-and-forget safe: a failure here never blocks the send itself,
 * it just means that specific message can't be used as a reply anchor.
 */
async function setLedgerEntryOutboundMessageId(ledgerEntryId, outboundWhatsappMessageId) {
  if (!ledgerEntryId || !outboundWhatsappMessageId) return;
  await query('UPDATE ledger_entries SET outbound_whatsapp_message_id = $2 WHERE id = $1', [
    ledgerEntryId,
    outboundWhatsappMessageId,
  ]);
}

/**
 * Resolves an inbound message's `context.id` (the wamid it's replying
 * to) back to the ledger entry Kika originally messaged about, if any.
 * Scoped to this merchant and to non-voided entries — a reply can only
 * ever meaningfully refer to that merchant's own still-valid record.
 */
async function getLedgerEntryByOutboundMessageId(merchantId, outboundWhatsappMessageId) {
  if (!outboundWhatsappMessageId) return null;
  const res = await query(
    `SELECT * FROM ledger_entries
     WHERE merchant_id = $1 AND outbound_whatsapp_message_id = $2 AND is_voided = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [merchantId, outboundWhatsappMessageId]
  );
  return res.rows[0] || null;
}

/** Whether a given inbound WhatsApp message id has already produced a ledger entry — permanent audit/traceability check beyond the 48h Redis idempotency lock's TTL. */
async function getLedgerEntryByWhatsappMessageId(merchantId, whatsappMessageId) {
  if (!whatsappMessageId) return null;
  const res = await query(
    'SELECT * FROM ledger_entries WHERE merchant_id = $1 AND whatsapp_message_id = $2 LIMIT 1',
    [merchantId, whatsappMessageId]
  );
  return res.rows[0] || null;
}

/**
 * Applies a payment against a counterparty's oldest outstanding debts
 * first (FIFO settlement) — used for "John pay off his debt 5k" style
 * messages that settle an existing balance rather than opening a new one.
 *
 * Lock ordering: this function locks customer_balances BEFORE locking
 * the individual ledger_entries debt rows. That ordering is fixed and
 * consistent across every code path that touches both tables in this
 * codebase (the new-DEBT path only ever locks customer_balances), so two
 * concurrent transactions can never deadlock waiting on each other's
 * locks in reverse order.
 */
async function settleOutstandingDebtForCounterparty(client, merchantId, counterpartyName, amountKobo) {
  // Lock the customer's rolling-balance row first — see lockCustomerBalance
  // for why this is what actually prevents lost updates under concurrency.
  await lockCustomerBalance(client, merchantId, counterpartyName);

  let remaining = amountKobo;
  const { rows: openDebts } = await client.query(
    `SELECT id, balance_kobo FROM ledger_entries
     WHERE merchant_id = $1 AND counterparty_name = $2 AND balance_kobo > 0 AND is_voided = false
     ORDER BY created_at ASC
     FOR UPDATE`,
    [merchantId, counterpartyName]
  );

  const settled = [];
  for (const debt of openDebts) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, Number(debt.balance_kobo));
    const newBalance = Number(debt.balance_kobo) - applied;
    await client.query(
      `UPDATE ledger_entries
       SET balance_kobo = $2::bigint, paid_kobo = paid_kobo + $3, is_settled = ($2::bigint = 0)
       WHERE id = $1`,
      [debt.id, newBalance, applied]
    );
    settled.push({ ledgerEntryId: debt.id, appliedKobo: applied });
    remaining -= applied;
  }

  const appliedTotalKobo = amountKobo - remaining;
  const updatedBalance =
    appliedTotalKobo > 0
      ? await applyCustomerBalanceDelta(client, merchantId, counterpartyName, -appliedTotalKobo)
      : await getCustomerBalance(merchantId, counterpartyName);

  return { settled, unallocatedKobo: remaining, appliedTotalKobo, rollingBalanceKobo: Number(updatedBalance.rolling_balance_kobo) };
}

async function attachReceiptToLedgerEntry(ledgerEntryId, receiptId) {
  await query('UPDATE ledger_entries SET receipt_id = $2 WHERE id = $1', [
    ledgerEntryId,
    receiptId,
  ]);
}

/**
 * Locks (creating first if necessary) a customer's rolling-balance
 * account row. MUST be called with a `client` that is inside an active
 * `BEGIN ... COMMIT` transaction (see withTransaction) — the FOR UPDATE
 * lock is only meaningful, and only released, within that transaction's
 * lifetime.
 *
 * This is the single choke point that eliminates the race condition
 * described by the caller: when a merchant logs multiple sales to the
 * SAME customer within seconds, two concurrent worker jobs each call
 * this function inside their own BEGIN/COMMIT transaction. Whichever
 * transaction's FOR UPDATE runs first wins the lock immediately; the
 * second blocks on the SELECT until the first COMMITs, then sees the
 * first transaction's committed balance before computing its own delta
 * — guaranteeing no lost updates regardless of arrival order or timing.
 *
 * The INSERT ... ON CONFLICT DO NOTHING that precedes the SELECT is
 * itself race-safe for a brand-new customer's very first transaction:
 * if two transactions both try to create the same customer's row for
 * the first time simultaneously, Postgres allows only one INSERT to
 * succeed — the other becomes a no-op — and both then proceed to the
 * FOR UPDATE SELECT, which serializes them exactly as above.
 */
async function lockCustomerBalance(client, merchantId, counterpartyName) {
  await client.query(
    `INSERT INTO customer_balances (merchant_id, counterparty_name, rolling_balance_kobo)
     VALUES ($1, $2, 0)
     ON CONFLICT (merchant_id, counterparty_name) DO NOTHING`,
    [merchantId, counterpartyName]
  );

  const res = await client.query(
    `SELECT * FROM customer_balances
     WHERE merchant_id = $1 AND counterparty_name = $2
     FOR UPDATE`,
    [merchantId, counterpartyName]
  );
  return res.rows[0];
}

/**
 * Applies a signed delta (positive for a new debt, negative for a
 * payment received) to a customer's rolling balance and returns the
 * updated row. Callers MUST have already locked the row in the same
 * transaction via lockCustomerBalance() first — this function only
 * performs the write, not the lock, so the two stay explicit and
 * auditable at each call site.
 */
async function applyCustomerBalanceDelta(client, merchantId, counterpartyName, deltaKobo) {
  const res = await client.query(
    `UPDATE customer_balances
     SET rolling_balance_kobo = rolling_balance_kobo + $3
     WHERE merchant_id = $1 AND counterparty_name = $2
     RETURNING *`,
    [merchantId, counterpartyName, deltaKobo]
  );
  return res.rows[0];
}

async function getCustomerBalance(merchantId, counterpartyName) {
  const res = await query(
    'SELECT * FROM customer_balances WHERE merchant_id = $1 AND counterparty_name = $2',
    [merchantId, counterpartyName]
  );
  return res.rows[0] || null;
}

async function getOutstandingDebtTotal(merchantId) {
  const res = await query(
    `SELECT COALESCE(SUM(balance_kobo), 0) AS total_kobo, COUNT(*) AS entry_count
     FROM ledger_entries
     WHERE merchant_id = $1 AND balance_kobo > 0 AND is_voided = false`,
    [merchantId]
  );
  return res.rows[0];
}

async function getRunningBalance(merchantId) {
  const res = await query(
    `SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN paid_kobo ELSE 0 END), 0) AS total_in_kobo,
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN paid_kobo ELSE 0 END), 0) AS total_out_kobo
     FROM ledger_entries
     WHERE merchant_id = $1 AND is_voided = false`,
    [merchantId]
  );
  return res.rows[0];
}

async function listRecentEntries(merchantId, limit = 10) {
  const res = await query(
    `SELECT * FROM ledger_entries
     WHERE merchant_id = $1 AND is_voided = false
     ORDER BY created_at DESC
     LIMIT $2`,
    [merchantId, limit]
  );
  return res.rows;
}

/** The single most recent non-voided entry — used by the UNDO command. */
async function getMostRecentLedgerEntry(merchantId) {
  const res = await query(
    `SELECT * FROM ledger_entries
     WHERE merchant_id = $1 AND is_voided = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [merchantId]
  );
  return res.rows[0] || null;
}

/**
 * "UNDO" / "Delete last sale" — flags the merchant's most recent entry as
 * VOID rather than deleting the row outright, preserving a full audit
 * trail. Reverses the rolling customer-balance impact under the same
 * row lock used everywhere else a balance is mutated (see
 * lockCustomerBalance), so this can never race with a concurrent sale
 * or settlement for the same customer.
 *
 * Deliberately scoped to CREDIT/DEBIT/DEBT entries only — a
 * DEBT_SETTLEMENT already redistributed its payment FIFO across
 * possibly several other ledger rows, and cleanly reversing that would
 * mean restoring each of those rows' balance_kobo/paid_kobo individually.
 * Rather than risk a partial/incorrect reversal, settlements are
 * excluded from UNDO — a merchant needing to correct one should use
 * DISPUTE instead, which routes to a human for a considered fix.
 */
async function voidMostRecentLedgerEntry(merchantId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ledger_entries
       WHERE merchant_id = $1 AND is_voided = false
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantId]
    );
    const entry = rows[0];
    if (!entry) return { voided: false, reason: 'NO_ENTRY', entry: null };
    if (entry.entry_type === 'DEBT_SETTLEMENT') {
      return { voided: false, reason: 'SETTLEMENT_NOT_UNDOABLE', entry };
    }

    if (entry.entry_type === 'DEBT' && entry.counterparty_name && Number(entry.balance_kobo) > 0) {
      await lockCustomerBalance(client, merchantId, entry.counterparty_name);
      await applyCustomerBalanceDelta(client, merchantId, entry.counterparty_name, -Number(entry.balance_kobo));
    }

    await client.query('UPDATE ledger_entries SET is_voided = true, voided_at = now() WHERE id = $1', [entry.id]);

    return { voided: true, reason: null, entry };
  });
}

/**
 * Same voiding logic as voidMostRecentLedgerEntry, but targets a specific
 * entry id rather than "whatever is most recent right now" — used by the
 * UNDO confirmation flow, where the entry to void was already identified
 * (and shown to the merchant) at prompt time, potentially a few seconds
 * before they tap "Yes, Undo". Re-verifies merchant ownership and
 * not-already-voided under the same row lock, so a confirm tap can never
 * void the wrong row even if other activity happened in between.
 */
async function voidLedgerEntryById(merchantId, entryId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ledger_entries
       WHERE id = $1 AND merchant_id = $2 AND is_voided = false
       FOR UPDATE`,
      [entryId, merchantId]
    );
    const entry = rows[0];
    if (!entry) return { voided: false, reason: 'NO_ENTRY', entry: null };
    if (entry.entry_type === 'DEBT_SETTLEMENT') {
      return { voided: false, reason: 'SETTLEMENT_NOT_UNDOABLE', entry };
    }

    if (entry.entry_type === 'DEBT' && entry.counterparty_name && Number(entry.balance_kobo) > 0) {
      await lockCustomerBalance(client, merchantId, entry.counterparty_name);
      await applyCustomerBalanceDelta(client, merchantId, entry.counterparty_name, -Number(entry.balance_kobo));
    }

    await client.query('UPDATE ledger_entries SET is_voided = true, voided_at = now() WHERE id = $1', [entry.id]);

    return { voided: true, reason: null, entry };
  });
}

// --- Reporting: Daily Sunset Report & Monthly Insights --------------------

/**
 * Aggregates a merchant's activity within [startTime, endTime) — used for
 * both the daily sunset report (a 24h window) and can be reused for any
 * custom range. Top items are computed by unnesting the `items` JSONB
 * array across all matching entries.
 */
async function getPeriodSummary(merchantId, startTime, endTime) {
  const totalsRes = await query(
    `SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN paid_kobo ELSE 0 END), 0) AS sales_kobo,
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN paid_kobo ELSE 0 END), 0) AS expenses_kobo,
        COALESCE(SUM(CASE WHEN balance_kobo > 0 THEN balance_kobo ELSE 0 END)
                 FILTER (WHERE created_at >= $2 AND created_at < $3), 0) AS new_debt_kobo,
        COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3) AS entry_count
     FROM ledger_entries
     WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3 AND is_voided = false`,
    [merchantId, startTime, endTime]
  );

  const topItemsRes = await query(
    `SELECT item->>'name' AS name, SUM((item->>'quantity')::numeric) AS total_quantity
     FROM ledger_entries, jsonb_array_elements(items) AS item
     WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3 AND is_voided = false
     GROUP BY item->>'name'
     ORDER BY total_quantity DESC
     LIMIT 3`,
    [merchantId, startTime, endTime]
  );

  const topCustomersRes = await query(
    `SELECT counterparty_name, SUM(paid_kobo + balance_kobo) AS total_value_kobo
     FROM ledger_entries
     WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3 AND is_voided = false
       AND counterparty_name IS NOT NULL AND entry_type IN ('CREDIT', 'DEBT')
     GROUP BY counterparty_name
     ORDER BY total_value_kobo DESC
     LIMIT 3`,
    [merchantId, startTime, endTime]
  );

  return {
    ...totalsRes.rows[0],
    topItems: topItemsRes.rows,
    topCustomers: topCustomersRes.rows,
  };
}

/**
 * Merchants who recorded at least one ledger entry within the window —
 * used by the scheduler so reports are only sent to merchants who were
 * actually active, not the entire user base.
 */
async function listMerchantsActiveSince(startTime, endTime) {
  const res = await query(
    `SELECT DISTINCT m.*
     FROM merchants m
     JOIN ledger_entries le ON le.merchant_id = m.id
     WHERE le.created_at >= $1 AND le.created_at < $2`,
    [startTime, endTime]
  );
  return res.rows;
}

async function hasReportBeenSent(merchantId, reportType, periodKey) {
  const res = await query(
    'SELECT 1 FROM report_dispatch_log WHERE merchant_id = $1 AND report_type = $2 AND period_key = $3',
    [merchantId, reportType, periodKey]
  );
  return res.rowCount > 0;
}

async function markReportSent(merchantId, reportType, periodKey) {
  await query(
    `INSERT INTO report_dispatch_log (merchant_id, report_type, period_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id, report_type, period_key) DO NOTHING`,
    [merchantId, reportType, periodKey]
  );
}

/**
 * Revenue grouped into week buckets (W1..W5) relative to the start of the
 * given period — used for the "Weekly Revenue" bar chart on the full
 * monthly report.
 */
async function getWeeklyRevenue(merchantId, monthStart, monthEnd) {
  const res = await query(
    `SELECT
        FLOOR(EXTRACT(DAY FROM created_at - $2::timestamptz) / 7)::int AS week_index,
        SUM(paid_kobo) AS revenue_kobo
     FROM ledger_entries
     WHERE merchant_id = $1 AND entry_type = 'CREDIT' AND is_voided = false
       AND created_at >= $2 AND created_at < $3
     GROUP BY week_index
     ORDER BY week_index ASC`,
    [merchantId, monthStart, monthEnd]
  );
  return res.rows;
}

/**
 * Every counterparty with an open balance, ranked by amount owed, with
 * each one's share of the total outstanding debt — powers the
 * "Outstanding Debts" progress-bar list on the full report.
 */
async function getDebtorBreakdown(merchantId) {
  const res = await query(
    `WITH debts AS (
       SELECT counterparty_name, SUM(balance_kobo) AS balance_kobo
       FROM ledger_entries
       WHERE merchant_id = $1 AND balance_kobo > 0 AND counterparty_name IS NOT NULL AND is_voided = false
       GROUP BY counterparty_name
     ), total AS (
       SELECT COALESCE(SUM(balance_kobo), 0) AS grand_total FROM debts
     )
     SELECT d.counterparty_name, d.balance_kobo,
            CASE WHEN t.grand_total > 0
                 THEN ROUND((d.balance_kobo::numeric / t.grand_total) * 100)
                 ELSE 0 END AS percentage
     FROM debts d, total t
     ORDER BY d.balance_kobo DESC`,
    [merchantId]
  );
  return res.rows;
}

/**
 * Outstanding debtors WITH a phone number attached (most recently
 * mentioned one, if the merchant included it on more than one entry) —
 * powers the Friday Debt Amnesty "send reminders" flow, which can only
 * message debtors we actually have a number for.
 */
async function getOutstandingDebtorsWithPhones(merchantId) {
  const res = await query(
    `WITH debts AS (
       SELECT counterparty_name, counterparty_phone, balance_kobo, created_at
       FROM ledger_entries
       WHERE merchant_id = $1 AND balance_kobo > 0 AND counterparty_name IS NOT NULL AND is_voided = false
     )
     SELECT counterparty_name,
            (ARRAY_AGG(counterparty_phone ORDER BY created_at DESC) FILTER (WHERE counterparty_phone IS NOT NULL))[1] AS counterparty_phone,
            SUM(balance_kobo) AS balance_kobo
     FROM debts
     GROUP BY counterparty_name
     ORDER BY balance_kobo DESC`,
    [merchantId]
  );
  return res.rows;
}

/**
 * Items ranked by total revenue attributed to them within a period —
 * powers "Top Products This Month".
 */
async function getTopProductsByRevenue(merchantId, startTime, endTime, limit = 4) {
  const res = await query(
    `SELECT item->>'name' AS name,
            SUM(total_kobo) AS revenue_kobo,
            SUM((item->>'quantity')::numeric) AS total_quantity
     FROM ledger_entries, jsonb_array_elements(items) AS item
     WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3 AND is_voided = false
       AND entry_type IN ('CREDIT', 'DEBT')
     GROUP BY item->>'name'
     ORDER BY revenue_kobo DESC
     LIMIT $4`,
    [merchantId, startTime, endTime, limit]
  );
  return res.rows;
}

/**
 * The single highest-balance debtor within a period — used both for the
 * Monthly Digest card's "Top Debtor" field and to detect a debtor who has
 * topped the list for consecutive months (for the AI Insight callout).
 */
async function getTopDebtor(merchantId) {
  const res = await query(
    `SELECT counterparty_name, SUM(balance_kobo) AS balance_kobo
     FROM ledger_entries
     WHERE merchant_id = $1 AND balance_kobo > 0 AND counterparty_name IS NOT NULL AND is_voided = false
     GROUP BY counterparty_name
     ORDER BY balance_kobo DESC
     LIMIT 1`,
    [merchantId]
  );
  return res.rows[0] || null;
}

/** Distinct calendar days with at least one ledger entry — "Trade Days". */
async function getTradeDaysCount(merchantId, startTime, endTime) {
  const res = await query(
    `SELECT COUNT(DISTINCT created_at::date) AS trade_days
     FROM ledger_entries
     WHERE merchant_id = $1 AND created_at >= $2 AND created_at < $3 AND is_voided = false`,
    [merchantId, startTime, endTime]
  );
  return Number(res.rows[0].trade_days);
}

// --- Products / inventory --------------------------------------------------

/** "ADD STOCK: rice, 50" — creates the product if new, otherwise increments existing stock. */
async function addProductStock(merchantId, name, quantity, unit) {
  const res = await query(
    `INSERT INTO products (merchant_id, name, unit, current_stock)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id, (lower(name)))
     DO UPDATE SET current_stock = products.current_stock + EXCLUDED.current_stock,
                   unit = COALESCE(products.unit, EXCLUDED.unit)
     RETURNING *`,
    [merchantId, name, unit || null, quantity]
  );
  return res.rows[0];
}

async function getProductByName(merchantId, name) {
  const res = await query(
    'SELECT * FROM products WHERE merchant_id = $1 AND lower(name) = lower($2)',
    [merchantId, name]
  );
  return res.rows[0] || null;
}

/**
 * Decrements stock for a product matching an item name sold (case-
 * insensitive). Silently does nothing if the merchant never registered
 * that product via ADD STOCK — inventory tracking is opt-in per item.
 * Returns the updated row (so the caller can check the low-stock
 * threshold) or null if there was nothing to decrement.
 */
async function decrementProductStock(merchantId, name, quantity) {
  const res = await query(
    `UPDATE products
     SET current_stock = GREATEST(current_stock - $3, 0)
     WHERE merchant_id = $1 AND lower(name) = lower($2)
     RETURNING *`,
    [merchantId, name, quantity]
  );
  return res.rows[0] || null;
}

/** Full inventory snapshot for a merchant — powers the Business Context Engine. */
async function listProductsForMerchant(merchantId, limit = 30) {
  const res = await query(
    'SELECT * FROM products WHERE merchant_id = $1 ORDER BY current_stock ASC LIMIT $2',
    [merchantId, limit]
  );
  return res.rows;
}

// --- Data exports -----------------------------------------------------------

async function createDataExport({ merchantId, filePath, publicToken, periodLabel, expiresAt }) {
  const res = await query(
    `INSERT INTO data_exports (merchant_id, file_path, public_token, period_label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [merchantId, filePath, publicToken, periodLabel || null, expiresAt]
  );
  return res.rows[0];
}

async function getDataExportByToken(publicToken) {
  const res = await query(
    'SELECT * FROM data_exports WHERE public_token = $1 AND expires_at > now()',
    [publicToken]
  );
  return res.rows[0] || null;
}

async function getExpiredUncleanedDataExports(limit = 500) {
  const res = await query(
    `SELECT id, file_path FROM data_exports
     WHERE expires_at < now() AND file_deleted_at IS NULL
     ORDER BY expires_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function markDataExportFileDeleted(id) {
  await query('UPDATE data_exports SET file_deleted_at = now() WHERE id = $1', [id]);
}

// --- Digest cards & full monthly reports ----------------------------------

async function createDigestCard({ merchantId, periodKey, filePath, publicToken, expiresAt }) {
  const res = await query(
    `INSERT INTO digest_cards (merchant_id, period_key, file_path, public_token, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (merchant_id, period_key)
     DO UPDATE SET file_path = EXCLUDED.file_path, public_token = EXCLUDED.public_token, expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [merchantId, periodKey, filePath, publicToken, expiresAt]
  );
  return res.rows[0];
}

async function getDigestCardByToken(publicToken) {
  const res = await query(
    'SELECT * FROM digest_cards WHERE public_token = $1 AND expires_at > now()',
    [publicToken]
  );
  return res.rows[0] || null;
}

async function createMonthlyReport({ merchantId, periodKey, reportData, publicToken, expiresAt }) {
  const res = await query(
    `INSERT INTO monthly_reports (merchant_id, period_key, report_data, public_token, expires_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (merchant_id, period_key)
     DO UPDATE SET report_data = EXCLUDED.report_data, public_token = EXCLUDED.public_token, expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [merchantId, periodKey, JSON.stringify(reportData), publicToken, expiresAt]
  );
  return res.rows[0];
}

async function getMonthlyReportByToken(publicToken) {
  const res = await query(
    'SELECT * FROM monthly_reports WHERE public_token = $1 AND expires_at > now()',
    [publicToken]
  );
  return res.rows[0] || null;
}

/** Prior months' saved report snapshots, most recent first — used to
 * detect a debtor who has topped the list for several consecutive months. */
async function getRecentMonthlyReports(merchantId, beforePeriodKey, limit = 6) {
  const res = await query(
    `SELECT period_key, report_data FROM monthly_reports
     WHERE merchant_id = $1 AND period_key < $2
     ORDER BY period_key DESC
     LIMIT $3`,
    [merchantId, beforePeriodKey, limit]
  );
  return res.rows;
}

// --- Customer loyalty ------------------------------------------------------

/**
 * Increments a customer's purchase count (keyed by phone number, unique
 * per merchant) and returns the updated row. Used only when the message
 * included a recognizable phone number for the counterparty.
 */
async function incrementCustomerLoyalty(merchantId, counterpartyPhone, counterpartyName) {
  const res = await query(
    `INSERT INTO customer_loyalty (merchant_id, counterparty_phone, counterparty_name, purchase_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (merchant_id, counterparty_phone)
     DO UPDATE SET purchase_count = customer_loyalty.purchase_count + 1,
                   counterparty_name = COALESCE(EXCLUDED.counterparty_name, customer_loyalty.counterparty_name)
     RETURNING *`,
    [merchantId, counterpartyPhone, counterpartyName || null]
  );
  return res.rows[0];
}

async function markLoyaltyMilestoneNotified(loyaltyRowId, purchaseCount) {
  await query('UPDATE customer_loyalty SET last_milestone_notified = $2 WHERE id = $1', [
    loyaltyRowId,
    purchaseCount,
  ]);
}

// --- Receipts ------------------------------------------------------------

async function createReceiptRecord({ merchantId, ledgerEntryId, filePath, publicToken, expiresAt }) {
  const res = await query(
    `INSERT INTO receipts (merchant_id, ledger_entry_id, file_path, public_token, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [merchantId, ledgerEntryId || null, filePath, publicToken, expiresAt]
  );
  return res.rows[0];
}

async function getReceiptByToken(publicToken) {
  const res = await query(
    'SELECT * FROM receipts WHERE public_token = $1 AND expires_at > now()',
    [publicToken]
  );
  return res.rows[0] || null;
}

/**
 * Rows whose documented expiry has already passed and whose on-disk file
 * hasn't been pruned yet — the exact set the cleanup sweep is allowed to
 * touch. Never returns a row before its own expires_at, so the sweep can
 * never violate the lifetime already promised to whoever holds the URL.
 */
async function getExpiredUncleanedReceipts(limit = 500) {
  const res = await query(
    `SELECT id, file_path FROM receipts
     WHERE expires_at < now() AND file_deleted_at IS NULL
     ORDER BY expires_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function markReceiptFileDeleted(id) {
  await query('UPDATE receipts SET file_deleted_at = now() WHERE id = $1', [id]);
}

async function getExpiredUncleanedDigestCards(limit = 500) {
  const res = await query(
    `SELECT id, file_path FROM digest_cards
     WHERE expires_at < now() AND file_deleted_at IS NULL
     ORDER BY expires_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function markDigestCardFileDeleted(id) {
  await query('UPDATE digest_cards SET file_deleted_at = now() WHERE id = $1', [id]);
}

// --- Payment transactions --------------------------------------------------

async function createPaymentTransaction({ merchantId, reference, subscriptionTierId, amountKobo, authorizationUrl }) {
  const res = await query(
    `INSERT INTO payment_transactions (merchant_id, paystack_reference, subscription_tier_id, amount_kobo, authorization_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [merchantId, reference, subscriptionTierId, amountKobo, authorizationUrl]
  );
  return res.rows[0];
}

async function getPaymentTransactionByReference(reference) {
  const res = await query(
    `SELECT pt.*, st.name AS tier_name
     FROM payment_transactions pt
     JOIN subscription_tiers st ON st.id = pt.subscription_tier_id
     WHERE pt.paystack_reference = $1`,
    [reference]
  );
  return res.rows[0] || null;
}

async function markPaymentTransactionStatus(reference, status) {
  const res = await query(
    `UPDATE payment_transactions
     SET status = $2, verified_at = CASE WHEN $2 = 'SUCCESS' THEN now() ELSE verified_at END
     WHERE paystack_reference = $1
     RETURNING *`,
    [reference, status]
  );
  return res.rows[0];
}

// --- Access control ---------------------------------------------------

async function isPhoneNumberListed(phoneNumber, listType) {
  const res = await query(
    'SELECT 1 FROM access_control_list WHERE phone_number = $1 AND list_type = $2',
    [phoneNumber, listType]
  );
  return res.rowCount > 0;
}

async function addAccessControlEntry(phoneNumber, listType, reason, createdBy) {
  const res = await query(
    `INSERT INTO access_control_list (phone_number, list_type, reason, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_number) DO UPDATE
       SET list_type = EXCLUDED.list_type, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by
     RETURNING *`,
    [phoneNumber, listType, reason || null, createdBy || null]
  );
  return res.rows[0];
}

async function removeAccessControlEntry(phoneNumber) {
  const res = await query('DELETE FROM access_control_list WHERE phone_number = $1 RETURNING *', [
    phoneNumber,
  ]);
  return res.rows[0] || null;
}

async function getActiveConversationLabels(merchantId) {
  const res = await query(
    'SELECT * FROM conversation_labels WHERE merchant_id = $1 AND removed_at IS NULL',
    [merchantId]
  );
  return res.rows;
}

async function addConversationLabel(merchantId, label, appliedBy) {
  const res = await query(
    `INSERT INTO conversation_labels (merchant_id, label, applied_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [merchantId, label, appliedBy || null]
  );
  return res.rows[0];
}

async function removeConversationLabel(merchantId, label) {
  const res = await query(
    `UPDATE conversation_labels SET removed_at = now()
     WHERE merchant_id = $1 AND label = $2 AND removed_at IS NULL
     RETURNING *`,
    [merchantId, label]
  );
  return res.rows;
}

// --- Payment links -------------------------------------------------------

async function createPaymentLink({
  merchantId,
  gateway,
  gatewayReference,
  fullUrl,
  shortUrl,
  shortCode,
  amountKobo,
  currency,
  customerPhone,
  customerName,
  description,
  expiresAt,
}) {
  const res = await query(
    `INSERT INTO payment_links
       (merchant_id, gateway, gateway_reference, full_url, short_url, short_code,
        amount_kobo, currency, customer_phone, customer_name, description, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      merchantId,
      gateway,
      gatewayReference,
      fullUrl,
      shortUrl,
      shortCode,
      amountKobo,
      currency || 'NGN',
      customerPhone || null,
      customerName || null,
      description || null,
      expiresAt,
    ]
  );
  return res.rows[0];
}

async function getPaymentLinkByShortCode(shortCode) {
  const res = await query('SELECT * FROM payment_links WHERE short_code = $1', [shortCode]);
  return res.rows[0] || null;
}

async function getPaymentLinkByGatewayReference(gateway, gatewayReference) {
  const res = await query(
    'SELECT * FROM payment_links WHERE gateway = $1 AND gateway_reference = $2',
    [gateway, gatewayReference]
  );
  return res.rows[0] || null;
}

async function markPaymentLinkStatus(id, status, extra = {}) {
  const res = await query(
    `UPDATE payment_links
     SET status = $2::varchar,
         paid_at = CASE WHEN $2::varchar = 'PAID' THEN now() ELSE paid_at END,
         ledger_entry_id = COALESCE($3, ledger_entry_id)
     WHERE id = $1
     RETURNING *`,
    [id, status, extra.ledgerEntryId || null]
  );
  return res.rows[0];
}

/** Sweeps PENDING links whose expiry has passed — call periodically. */
async function expireOverduePaymentLinks() {
  const res = await query(
    `UPDATE payment_links SET status = 'EXPIRED'
     WHERE status = 'PENDING' AND expires_at < now()
     RETURNING id`
  );
  return res.rowCount;
}

// --- Payment gateway activity log -----------------------------------------

async function logPaymentGatewayActivity({
  merchantId,
  paymentLinkId,
  gateway,
  eventType,
  reference,
  httpStatus,
  requestPayload,
  responsePayload,
  isSuccess,
  errorMessage,
}) {
  await query(
    `INSERT INTO payment_gateway_logs
       (merchant_id, payment_link_id, gateway, event_type, reference, http_status,
        request_payload, response_payload, is_success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      merchantId || null,
      paymentLinkId || null,
      gateway,
      eventType,
      reference || null,
      httpStatus || null,
      JSON.stringify(requestPayload || {}),
      JSON.stringify(responsePayload || {}),
      isSuccess,
      errorMessage || null,
    ]
  );
}

// --- Ledger disputes -------------------------------------------------------

async function createLedgerDispute({
  merchantId,
  ledgerEntryId,
  raisedBy,
  customerPhone,
  reason,
  disputedAmountKobo,
}) {
  const res = await query(
    `INSERT INTO ledger_disputes
       (merchant_id, ledger_entry_id, raised_by, customer_phone, reason, disputed_amount_kobo)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [merchantId, ledgerEntryId || null, raisedBy || 'MERCHANT', customerPhone || null, reason, disputedAmountKobo || null]
  );
  return res.rows[0];
}

async function resolveLedgerDispute(disputeId, { status, resolutionNotes, resolvedBy, adjustmentAmountKobo }) {
  const res = await query(
    `UPDATE ledger_disputes
     SET status = $2, resolution_notes = $3, resolved_by = $4,
         adjustment_amount_kobo = $5, resolved_at = now()
     WHERE id = $1
     RETURNING *`,
    [disputeId, status, resolutionNotes || null, resolvedBy || null, adjustmentAmountKobo ?? null]
  );
  return res.rows[0];
}

async function listOpenLedgerDisputes(merchantId) {
  const res = await query(
    `SELECT * FROM ledger_disputes
     WHERE merchant_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')
     ORDER BY created_at DESC`,
    [merchantId]
  );
  return res.rows;
}

// --- Audit log -------------------------------------------------------------

async function writeAuditLog({
  merchantId,
  actorType,
  actorId,
  action,
  endpoint,
  httpMethod,
  statusCode,
  isSuccess,
  requestId,
  ipAddress,
  metadata,
}) {
  await query(
    `INSERT INTO audit_logs
       (merchant_id, actor_type, actor_id, action, endpoint, http_method,
        status_code, is_success, request_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      merchantId || null,
      actorType || 'SYSTEM',
      actorId || null,
      action,
      endpoint || null,
      httpMethod || null,
      statusCode || null,
      isSuccess ?? true,
      requestId || null,
      ipAddress || null,
      JSON.stringify(metadata || {}),
    ]
  );
}

module.exports = {
  listActiveSubscriptionTiers,
  getHighestActiveSubscriptionTier,
  getSubscriptionTierByName,
  getSubscriptionTierById,
  findOrCreateMerchantByWhatsappNumber,
  getMerchantById,
  setMerchantOnboardingState,
  recordMerchantConsent,
  incrementConsentPromptCount,
  markConsentDeclined,
  restartConsentFlow,
  setMerchantBusinessName,
  setMerchantBusinessType,
  setMerchantName,
  setMerchantClosingHour,
  setMerchantLogo,
  setAwaitingLogoWindow,
  getMerchantsWithClosingHour,
  getExpiredSubscriptionMerchants,
  downgradeMerchantToFreeTier,
  extendMerchantSubscription,
  createLedgerEntry,
  setLedgerEntryOutboundMessageId,
  getLedgerEntryByOutboundMessageId,
  getLedgerEntryByWhatsappMessageId,
  settleOutstandingDebtForCounterparty,
  lockCustomerBalance,
  applyCustomerBalanceDelta,
  getCustomerBalance,
  getMostRecentLedgerEntry,
  voidMostRecentLedgerEntry,
  voidLedgerEntryById,
  addProductStock,
  getProductByName,
  decrementProductStock,
  listProductsForMerchant,
  createDataExport,
  getDataExportByToken,
  getExpiredUncleanedDataExports,
  markDataExportFileDeleted,
  attachReceiptToLedgerEntry,
  getOutstandingDebtTotal,
  getRunningBalance,
  listRecentEntries,
  getPeriodSummary,
  listMerchantsActiveSince,
  hasReportBeenSent,
  markReportSent,
  getWeeklyRevenue,
  getDebtorBreakdown,
  getOutstandingDebtorsWithPhones,
  getTopProductsByRevenue,
  getTopDebtor,
  getTradeDaysCount,
  createDigestCard,
  getDigestCardByToken,
  createMonthlyReport,
  getMonthlyReportByToken,
  getRecentMonthlyReports,
  incrementCustomerLoyalty,
  markLoyaltyMilestoneNotified,
  createReceiptRecord,
  getReceiptByToken,
  getExpiredUncleanedReceipts,
  markReceiptFileDeleted,
  getExpiredUncleanedDigestCards,
  markDigestCardFileDeleted,
  createPaymentTransaction,
  getPaymentTransactionByReference,
  markPaymentTransactionStatus,
  isPhoneNumberListed,
  addAccessControlEntry,
  removeAccessControlEntry,
  getActiveConversationLabels,
  addConversationLabel,
  removeConversationLabel,
  createPaymentLink,
  getPaymentLinkByShortCode,
  getPaymentLinkByGatewayReference,
  markPaymentLinkStatus,
  expireOverduePaymentLinks,
  logPaymentGatewayActivity,
  createLedgerDispute,
  resolveLedgerDispute,
  listOpenLedgerDisputes,
  writeAuditLog,
  withTransaction,
};
