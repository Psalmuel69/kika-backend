'use strict';

const { scheduledReportsQueue } = require('./queues');
const logger = require('../utils/logger');

/**
 * Registers the recurring broadcast + maintenance jobs. BullMQ's
 * repeatable-job dedupe means calling this on every process start is
 * safe — it will not create duplicate schedules for the same job name +
 * cron pattern, and only one worker replica picks up each produced tick
 * even when multiple worker containers are running.
 *
 * - Business Sunset ping: checks HOURLY (not a single fixed time) and
 *   fans out only to merchants whose own `closing_hour_local` matches
 *   the current Africa/Lagos hour — each merchant gets their recap at
 *   the closing hour they've configured (default 19:00 / 7pm) via the
 *   "CLOSING HOUR <hour>" command, not a one-size-fits-all cron.
 * - Monthly Insights / Digest: fires on the 1st of each month and fans
 *   out to every merchant active in the prior calendar month.
 * - Subscription expiry sweep: checks every 15 minutes for merchants
 *   whose paid subscription has lapsed and downgrades them to Free,
 *   sending the expiration notice.
 * - Friday Debt Amnesty prompt: fires Friday afternoon (default 15:00
 *   Lagos) and offers merchants with outstanding debtors a one-tap
 *   "send polite reminders" option — opt-in per week, never automatic.
 * - Storage cleanup sweep: fires every 15 minutes and prunes receipt/
 *   digest card/export files whose OWN already-documented expires_at has
 *   already passed — see diskCleanupService.js. This never deletes a
 *   file before the lifetime already promised to whoever holds its URL;
 *   it only stops disk usage from growing unbounded under volume.
 */
async function registerSchedules() {
  await scheduledReportsQueue.add(
    'daily-sunset-tick',
    {},
    {
      repeat: { pattern: process.env.DAILY_SUNSET_CRON || '0 * * * *', tz: 'Africa/Lagos' },
      jobId: 'daily-sunset-schedule',
    }
  );

  await scheduledReportsQueue.add(
    'monthly-insights-tick',
    {},
    {
      repeat: { pattern: process.env.MONTHLY_INSIGHTS_CRON || '0 8 1 * *', tz: 'Africa/Lagos' },
      jobId: 'monthly-insights-schedule',
    }
  );

  await scheduledReportsQueue.add(
    'subscription-expiry-tick',
    {},
    {
      repeat: { pattern: process.env.SUBSCRIPTION_EXPIRY_CRON || '*/15 * * * *' },
      jobId: 'subscription-expiry-schedule',
    }
  );

  await scheduledReportsQueue.add(
    'friday-amnesty-tick',
    {},
    {
      repeat: { pattern: process.env.FRIDAY_AMNESTY_CRON || '0 15 * * 5', tz: 'Africa/Lagos' },
      jobId: 'friday-amnesty-schedule',
    }
  );

  await scheduledReportsQueue.add(
    'scratchpad-cleanup-tick',
    {},
    {
      repeat: { pattern: process.env.STORAGE_CLEANUP_CRON || '*/15 * * * *' },
      jobId: 'scratchpad-cleanup-schedule',
    }
  );

  logger.info(
    'Scheduled jobs registered (business sunset + monthly insights + subscription expiry + Friday amnesty + storage cleanup)'
  );
}

module.exports = { registerSchedules };
