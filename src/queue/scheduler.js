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
 * - Daily Sunset Report: fires once every evening (default 19:00 Lagos
 *   time) and fans out to every merchant active in the last 24h.
 * - Monthly Insights: fires on the 1st of each month and fans out to
 *   every merchant active in the prior calendar month.
 * - Storage cleanup sweep: fires every 15 minutes and prunes receipt/
 *   digest card files whose OWN already-documented expires_at has
 *   already passed — see diskCleanupService.js. This never deletes a
 *   file before the lifetime already promised to whoever holds its URL
 *   (WhatsApp's own media fetch, or someone tapping "View Full Report"
 *   later); it only stops disk usage from growing unbounded under volume.
 */
async function registerSchedules() {
  await scheduledReportsQueue.add(
    'daily-sunset-tick',
    {},
    {
      repeat: { pattern: process.env.DAILY_SUNSET_CRON || '0 19 * * *', tz: 'Africa/Lagos' },
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
    'scratchpad-cleanup-tick',
    {},
    {
      repeat: { pattern: process.env.STORAGE_CLEANUP_CRON || '*/15 * * * *' },
      jobId: 'scratchpad-cleanup-schedule',
    }
  );

  logger.info('Scheduled jobs registered (daily sunset + monthly insights + storage cleanup)');
}

module.exports = { registerSchedules };
