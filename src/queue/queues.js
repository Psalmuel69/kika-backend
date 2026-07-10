'use strict';

const { Queue } = require('bullmq');
const { connection } = require('../config/redis');

/**
 * Every queue shares default job options tuned for a payments/messaging
 * workload: bounded retries with backoff (so a transient WhatsApp/Paystack
 * blip doesn't hammer either API), and automatic trimming of completed/failed
 * jobs so Redis memory doesn't grow unbounded under sustained traffic.
 */
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

const ledgerQueue = new Queue('kika-ledger-processing', { connection, defaultJobOptions });
const receiptQueue = new Queue('kika-receipt-generation', { connection, defaultJobOptions });
const whatsappQueue = new Queue('kika-whatsapp-dispatch', { connection, defaultJobOptions });
const webhookAlertQueue = new Queue('kika-webhook-alerts', { connection, defaultJobOptions });
const scheduledReportsQueue = new Queue('kika-scheduled-reports', { connection, defaultJobOptions });

module.exports = { ledgerQueue, receiptQueue, whatsappQueue, webhookAlertQueue, scheduledReportsQueue };
