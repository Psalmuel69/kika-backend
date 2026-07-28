'use strict';

// ---------------------------------------------------------------------------
// Onboarding / consent state machine — gates EVERYTHING else. A merchant
// can only log entries once they've accepted terms AND provided a
// business name (existing merchants who already passed this skip
// straight to normal processing, since their state is already ACTIVE+).
//
// Extracted out of worker.js as its own module, alongside invoiceFlow.js —
// same rationale: a cleanly bounded, self-contained conversation state
// machine with a small, stable dependency list.
// ---------------------------------------------------------------------------

const queries = require('../db/queries');
const whatsappService = require('../services/whatsappService');
const ledgerParser = require('../services/ledgerParser');
const nameExtractionService = require('../services/nameExtractionService');
const categorizationService = require('../services/categorizationService');
const auditLogService = require('../services/auditLogService');

// Onboarding gates ALL other processing until a merchant reaches one of
// the states past this list — the caller (worker.js) checks
// `ONBOARDING_GATE_STATES.includes(merchant.onboarding_state)` before
// doing anything else with an inbound message.
const ONBOARDING_GATE_STATES = ['PENDING_CONSENT', 'CONSENT_DECLINED', 'AWAITING_BUSINESS_NAME', 'AWAITING_BUSINESS_TYPE'];

const RESTART_TRIGGERS = ['hi', 'hello', 'start', 'menu', 'help', 'hey'];

// ---------------------------------------------------------------------------
// Onboarding / consent state machine — gates EVERYTHING else. A merchant
// can only log entries once they've accepted terms AND provided a
// business name (existing merchants who already passed this skip
// straight to normal processing, since their state is already ACTIVE+).
// ---------------------------------------------------------------------------
async function handleOnboarding(merchant, whatsappNumber, jobData) {
  const rawMessage = (jobData.rawMessage || '').trim();
  const isAgreeButtonTap = rawMessage === 'AGREE_TERMS';

  if (merchant.onboarding_state === 'PENDING_CONSENT') {
    if (isAgreeButtonTap) {
      await queries.recordMerchantConsent(merchant.id);
      await auditLogService.logEvent({ merchantId: merchant.id, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'consent.accepted' });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        "Account Activated! Your Kika Free Tier is live. Let's set up your business identity in 5 seconds.\n\n*What is the name of your business/shop?*"
      );
      return;
    }

    if (merchant.consent_prompt_count < 3) {
      await whatsappService.sendConsentPrompt(whatsappNumber);
      await queries.incrementConsentPromptCount(merchant.id);
      return;
    }

    // 3 nudges sent, still no accept — decline politely and go quiet
    // until the merchant proactively re-engages.
    await queries.markConsentDeclined(merchant.id);
    await whatsappService.sendTextMessage(
      whatsappNumber,
      "No worries \u2014 whenever you're ready to get started, just say *Hi* and we'll pick up right where we left off."
    );
    return;
  }

  if (merchant.onboarding_state === 'CONSENT_DECLINED') {
    if (RESTART_TRIGGERS.includes(rawMessage.toLowerCase())) {
      await queries.restartConsentFlow(merchant.id);
      await whatsappService.sendConsentPrompt(whatsappNumber);
      await queries.incrementConsentPromptCount(merchant.id);
    }
    // Otherwise: stay silent. This merchant declined onboarding; we
    // don't keep messaging a number that hasn't agreed to be contacted.
    return;
  }

  if (merchant.onboarding_state === 'AWAITING_BUSINESS_NAME') {
    if (jobData.mediaType !== 'text' || !rawMessage) {
      await whatsappService.sendTextMessage(whatsappNumber, 'What is the name of your business/shop? (please type it as text)');
      return;
    }
    // Merchants often answer in a full sentence ("my business name is
    // Ebuka & Sons Ltd", "Ebuka & Sons Ltd is the name") rather than
    // just the name — this goes on every receipt/invoice from here on,
    // so it's worth extracting properly rather than saving the whole
    // sentence verbatim. Deterministic stripping first (instant, no AI
    // cost — covers every phrasing tried above); only the rare leftover
    // that still doesn't look like a clean name falls back to a single
    // AI extraction call. See ledgerParser.extractBusinessNameFromReply
    // and nameExtractionService.extractNameWithAI.
    let businessName = ledgerParser.extractBusinessNameFromReply(rawMessage);
    if (!ledgerParser.looksLikeCleanName(businessName)) {
      const aiExtracted = await nameExtractionService.extractNameWithAI(rawMessage, 'business');
      businessName = aiExtracted || businessName;
    }
    businessName = (businessName || rawMessage).slice(0, 160);
    await queries.setMerchantBusinessName(merchant.id, businessName);
    await auditLogService.logEvent({ merchantId: merchant.id, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'onboarding.business_name_set', metadata: { businessName, rawMessage } });
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Nice, *${businessName}*! One last thing \u2014 what type of business is it? (e.g. "Provision store", "Hair salon", "Phone accessories")`
    );
    return;
  }

  if (merchant.onboarding_state === 'AWAITING_BUSINESS_TYPE') {
    if (jobData.mediaType !== 'text' || !rawMessage) {
      await whatsappService.sendTextMessage(whatsappNumber, 'What type of business is it? (please type it as text, e.g. "Provision store")');
      return;
    }
    const businessType = rawMessage.slice(0, 160);
    // Kika classifies the merchant's own free-text answer into one fixed
    // business_category (e.g. "Provision Store" -> "Retail") — see
    // categorizationService.js. Never blocks onboarding on this: any
    // failure just falls back to 'Other' inside the service itself.
    const businessCategory = await categorizationService.categorizeBusinessType(businessType, merchant.business_name);
    await queries.setMerchantBusinessType(merchant.id, businessType, businessCategory);
    await auditLogService.logEvent({
      merchantId: merchant.id,
      actorType: 'MERCHANT',
      actorId: whatsappNumber,
      action: 'onboarding.business_type_set',
      metadata: { businessType, businessCategory },
    });
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Perfect! *${merchant.business_name}* is officially registered on Kika. From now on, any sale you type will carry this name at the top of your digital receipts.\n\nTry it now \u2014 send something like "sold rice 5000" or type HELP for more examples.`
    );
  }
}

module.exports = {
  ONBOARDING_GATE_STATES,
  handleOnboarding,
};
