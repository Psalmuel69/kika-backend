'use strict';

const queries = require('../db/queries');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Both flows in this file are plain regex/state-machine logic — deliberately
// NOT routed through aiTransactionParser/openaiService. An NPS score or an
// email address is either a clean match or it isn't; there's no ambiguity
// for a model to resolve, and keeping this deterministic means it never
// costs an AI call, never hallucinates a score/email that wasn't actually
// given, and behaves identically every time.
// ---------------------------------------------------------------------------

const NPS_ONE_MONTH_DAYS = Number(process.env.NPS_ONE_MONTH_DAYS || 30);
const NPS_TRANSACTION_MILESTONE = Number(process.env.NPS_TRANSACTION_MILESTONE || 50);
const NPS_REPROMPT_COOLDOWN_DAYS = Number(process.env.NPS_REPROMPT_COOLDOWN_DAYS || 90);

const WEEKLY_TX_EMAIL_MILESTONE = Number(process.env.WEEKLY_TX_EMAIL_MILESTONE || 10);
const EMAIL_PROMPT_COOLDOWN_DAYS = Number(process.env.EMAIL_PROMPT_COOLDOWN_DAYS || 30);

function daysAgo(date) {
  return (Date.now() - new Date(date).getTime()) / (24 * 3600 * 1000);
}

// --- NPS -------------------------------------------------------------------

/**
 * Whether this merchant should be offered the NPS survey right now:
 * account age >= ~1 month OR total transactions >= the milestone, AND not
 * already mid-survey, AND (never asked before OR the cooldown has passed).
 * Called after a successful transaction recording (see worker.js) — that's
 * both a natural, non-intrusive moment and guarantees the transaction-count
 * condition is checked against up-to-date data.
 */
async function checkNpsTrigger(merchant) {
  if (merchant.nps_awaiting_stage) return null; // already mid-survey
  if (merchant.nps_last_prompted_at && daysAgo(merchant.nps_last_prompted_at) < NPS_REPROMPT_COOLDOWN_DAYS) return null;

  const accountAgeDays = daysAgo(merchant.created_at);
  if (accountAgeDays >= NPS_ONE_MONTH_DAYS) return 'ONE_MONTH';

  const txCount = await queries.getMerchantTransactionCount(merchant.id);
  if (txCount >= NPS_TRANSACTION_MILESTONE) return 'MILESTONE';

  return null;
}

const NPS_SCORE_QUESTION =
  'Quick one \u2014 on a scale of 0\u201310, how likely are you to recommend Kika to another business owner?\n\n(Just reply with a number from 0 to 10.)';

const NPS_REASON_QUESTION = 'Thanks! What\u2019s the main reason for your score?';

/**
 * Starts the survey: sets nps_awaiting_stage='SCORE', stamps
 * nps_last_prompted_at, remembers which condition triggered it (so the
 * eventual nps_responses row can record that), and returns the question
 * text to send.
 */
async function triggerNpsSurvey(merchantId, triggerReason) {
  await queries.startNpsSurvey(merchantId, triggerReason);
  return NPS_SCORE_QUESTION;
}

// Matches a bare 0-10 (optionally with "/10", "out of 10", surrounding
// words like "score: 8") — deliberately not a generic number extractor,
// since a merchant could plausibly reply with something like "8/10 because
// it's fast" and only the 8 should be read as the score.
const NPS_SCORE_RE = /\b(10|[0-9])\b(?:\s*\/\s*10|\s+out\s+of\s+10)?/i;

function parseNpsScore(text) {
  const match = String(text || '').match(NPS_SCORE_RE);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= 0 && score <= 10 ? score : null;
}

/** Standard NPS convention: 0-6 detractors, 7-8 passives, 9-10 promoters. */
function classifyNpsScore(score) {
  if (score <= 6) return 'low';
  if (score <= 8) return 'medium';
  return 'good';
}

function buildNpsScoreTierReply(tier) {
  if (tier === 'low') {
    return "Thank you for your honesty \u2014 we hear you, and we'll work on making Kika better for you.";
  }
  if (tier === 'medium') {
    return "Thanks for the feedback! We're always working to make Kika even better for businesses like yours.";
  }
  return "Thank you! We're so happy to see Kika is working well for your business \u2014 that really means a lot to us.";
}

/**
 * Handles a merchant's reply while nps_awaiting_stage is set. Returns the
 * text to send back. Never touches the AI pipeline or the normal ledger
 * parsers — this fully owns the message when a survey is in progress.
 */
async function handleNpsReply(merchant, rawMessage) {
  if (merchant.nps_awaiting_stage === 'SCORE') {
    const score = parseNpsScore(rawMessage);
    if (score == null) {
      return "Sorry, I didn't catch a number there \u2014 could you reply with a single number from 0 to 10?";
    }
    const npsResponse = await queries.createNpsResponse({
      merchantId: merchant.id,
      score,
      triggerReason: merchant.nps_pending_trigger_reason || 'MILESTONE',
    });
    await queries.setNpsAwaitingStage(merchant.id, 'REASON');
    logger.info({ merchantId: merchant.id, score, npsResponseId: npsResponse.id }, 'NPS score recorded');
    return NPS_REASON_QUESTION;
  }

  if (merchant.nps_awaiting_stage === 'REASON') {
    const openResponse = await queries.getLatestReasonlessNpsResponse(merchant.id);
    if (openResponse) {
      await queries.setNpsResponseReason(openResponse.id, String(rawMessage || '').slice(0, 1000));
      logger.info({ merchantId: merchant.id, npsResponseId: openResponse.id }, 'NPS reason recorded');
    }
    await queries.setNpsAwaitingStage(merchant.id, null);
    const tier = openResponse ? classifyNpsScore(openResponse.score) : 'medium';
    return buildNpsScoreTierReply(tier);
  }

  // Defensive fallback — shouldn't be reachable since callers only invoke
  // this when nps_awaiting_stage is one of the two values above.
  await queries.setNpsAwaitingStage(merchant.id, null);
  return null;
}

// --- Milestone-based opt-in email collection --------------------------------

/**
 * Whether to show the weekly-transaction-count email nudge right now:
 * at least WEEKLY_TX_EMAIL_MILESTONE transactions THIS WEEK, no email on
 * file yet, not already mid-flow, and not prompted within the cooldown.
 * Also called after a successful transaction recording.
 */
async function checkEmailMilestoneTrigger(merchant) {
  if (merchant.email) return null; // already have it — nothing to ask
  if (merchant.email_collection_awaiting_stage) return null; // already mid-flow
  if (
    merchant.email_collection_last_prompted_at &&
    daysAgo(merchant.email_collection_last_prompted_at) < EMAIL_PROMPT_COOLDOWN_DAYS
  ) {
    return null;
  }

  const weekStart = startOfWeekLagos(new Date());
  const weeklyCount = await queries.getMerchantTransactionCountSince(merchant.id, weekStart);
  if (weeklyCount < WEEKLY_TX_EMAIL_MILESTONE) return null;

  return weeklyCount;
}

function startOfWeekLagos(date) {
  // Africa/Lagos has no DST and is a fixed UTC+1, so a simple offset is
  // exact (not an approximation) — Monday 00:00 local time.
  const lagos = new Date(date.getTime() + 60 * 60 * 1000);
  const day = lagos.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() - diffToMonday));
  return new Date(monday.getTime() - 60 * 60 * 1000); // back to UTC
}

function buildEmailMilestoneMessage(weeklyCount) {
  return (
    `You've recorded ${weeklyCount} transactions with Kika this week.\n\n` +
    `Would you like me to email you:\n` +
    `\u2022 Weekly business reports\n` +
    `\u2022 Product updates\n` +
    `\u2022 Free business tips\n\n` +
    `If yes, reply with your email address.`
  );
}

/** Starts the email-collection flow: sets awaiting_stage='OPT_IN', stamps the cooldown timestamp, returns the message to send. */
async function triggerEmailMilestone(merchantId, weeklyCount) {
  await queries.setEmailCollectionAwaitingStage(merchantId, 'OPT_IN', { bumpPromptedAt: true });
  return buildEmailMilestoneMessage(weeklyCount);
}

const AFFIRMATIVE_RE = /^(y|yes|yeah|yea|yup|sure|ok|okay|please|go ahead|do it)\b/i;
const NEGATIVE_RE = /^(n|no|nah|nope|not now|not interested|skip|cancel|later)\b/i;
const ESCAPE_HATCH_RE = /^(skip|cancel|stop|no thanks|nevermind|never mind)\b/i;

function isAffirmative(text) {
  return AFFIRMATIVE_RE.test(String(text || '').trim());
}
function isNegative(text) {
  return NEGATIVE_RE.test(String(text || '').trim());
}

// A real email needs an "@" AND a dot-containing domain after it — this is
// the literal rule the person asked for ("if the response does not have an
// email domain, do not treat it as an email"), not a full RFC 5322
// validator (which would accept technically-legal-but-domain-less
// addresses this product has no use for anyway).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(text) {
  return EMAIL_RE.test(String(text || '').trim());
}

/**
 * Handles a merchant's reply while email_collection_awaiting_stage is set.
 * Returns the text to send back (or null if the flow was silently
 * abandoned, e.g. an unrecognized reply at OPT_IN that we're re-prompting
 * for — the caller still sends whatever non-null text comes back).
 */
async function handleEmailCollectionReply(merchant, rawMessage) {
  const text = String(rawMessage || '').trim();

  if (merchant.email_collection_awaiting_stage === 'OPT_IN') {
    if (isNegative(text)) {
      await queries.setEmailCollectionAwaitingStage(merchant.id, null);
      return "No problem \u2014 you can always ask me for this later!";
    }
    if (isAffirmative(text)) {
      await queries.setEmailCollectionAwaitingStage(merchant.id, 'EMAIL');
      return "Great! What's your email address?";
    }
    return "Just reply YES or NO \u2014 would you like weekly reports, product updates, and business tips by email?";
  }

  if (merchant.email_collection_awaiting_stage === 'EMAIL') {
    if (ESCAPE_HATCH_RE.test(text)) {
      await queries.setEmailCollectionAwaitingStage(merchant.id, null);
      return "No problem \u2014 you can always ask me for this later!";
    }
    if (!isValidEmail(text)) {
      // Explicitly NOT saved — an invalid/domain-less reply is never
      // written to merchants.email, per the requirement that only a
      // genuine email address (with a real domain) counts.
      return "That doesn't look like a valid email address \u2014 could you resend it? (e.g. name@example.com)";
    }
    await queries.setMerchantEmail(merchant.id, text.toLowerCase());
    await queries.setEmailCollectionAwaitingStage(merchant.id, null);
    logger.info({ merchantId: merchant.id }, 'Merchant email captured via opt-in flow');
    return `Got it \u2014 I've saved ${text.toLowerCase()}. You'll start getting your reports, updates, and tips there.`;
  }

  await queries.setEmailCollectionAwaitingStage(merchant.id, null);
  return null;
}

module.exports = {
  checkNpsTrigger,
  triggerNpsSurvey,
  handleNpsReply,
  parseNpsScore,
  classifyNpsScore,
  buildNpsScoreTierReply,
  checkEmailMilestoneTrigger,
  triggerEmailMilestone,
  handleEmailCollectionReply,
  isValidEmail,
  isAffirmative,
  isNegative,
};
