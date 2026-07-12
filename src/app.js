'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const logger = require('./utils/logger');
const auditLogger = require('./middleware/auditLogger');
const { errorHandler } = require('./middleware/validation');

const whatsappRoutes = require('./routes/whatsapp.routes');
const paystackRoutes = require('./routes/paystack.routes');
const receiptsRoutes = require('./routes/receipts.routes');
const reportsRoutes = require('./routes/reports.routes');
const pricingRoutes = require('./routes/pricing.routes');
const shortlinkRoutes = require('./routes/shortlink.routes');
const adminRoutes = require('./routes/admin.routes');
const exportsRoutes = require('./routes/exports.routes');
const healthRoutes = require('./routes/health.routes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // required for correct req.ip behind a load balancer/ingress

app.use(helmet());
app.use(cors({ origin: false })); // this is a machine-to-machine API (WhatsApp/Paystack callbacks + signed webhooks), not browser-facing
app.use(pinoHttp({ logger }));

/**
 * Captures the raw request body BEFORE JSON parsing, since both the
 * WhatsApp and Paystack signature checks are HMACs over the exact raw
 * bytes Meta/Paystack sent — verifying against a re-serialized JSON
 * object would silently fail on any whitespace/key-order difference.
 */
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Logs every request to audit_logs once the response finishes (see
// middleware/auditLogger.js) — "logs all activities where necessary."
app.use(auditLogger);

app.get('/', (req, res) => {
  res.json({ service: 'kika-backend', status: 'running' });
});

app.use('/api/v1', healthRoutes);
app.use('/api/v1', whatsappRoutes);
app.use('/api/v1/payments', paystackRoutes);
app.use('/api/v1', receiptsRoutes);
app.use('/api/v1', reportsRoutes);
app.use('/api/v1', pricingRoutes);
app.use('/api/v1', exportsRoutes);
app.use('/', shortlinkRoutes); // short.link/l/:code — kept off /api/v1 for a shorter customer-facing URL
app.use('/api/v1', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
