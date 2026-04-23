// src/server.js
// ─────────────────────────────────────────────────────────────
//  Vision Guard – Express.js Backend
//  Entry point: sets up middleware, mounts all routes,
//  starts the AI poller, and begins listening.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { errorHandler } = require('./middleware/errorHandler');
const { startPoller } = require('./services/aiPoller');

// ── Route modules ─────────────────────────────────────────────
const dashboardRoutes = require('./routes/dashboard');
const driverRoutes = require('./routes/drivers');
const violationRoutes = require('./routes/violations');
const fleetRoutes = require('./routes/fleetRoutes');
const reportRoutes = require('./routes/reports');
const settingRoutes    = require('./routes/settings');
const aiRoutes         = require('./routes/ai');
const penaltyRoutes    = require('./routes/penalties');
const fineAmountRoutes = require('./routes/fineAmounts');
const cronRoutes       = require('./routes/cron');

// ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;

// ── Security & parsing middleware ─────────────────────────────
app.use(helmet());

// Sanitize CORS origin (Vercel env vars sometimes contain trailing whitespace)
const corsOrigin = (process.env.CORS_ORIGIN || 'http://localhost:5173').trim();
app.use(cors({
  origin: corsOrigin.includes(',') ? corsOrigin.split(',').map(s => s.trim()) : corsOrigin,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health check (no auth needed) ────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Vision Guard API',
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/violations', violationRoutes);
app.use('/api/routes', fleetRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/penalties',    penaltyRoutes);
app.use('/api/fine-amounts', fineAmountRoutes);
app.use('/api/cron',         cronRoutes);

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found', code: 'NOT_FOUND' });
});

// ── Global error handler (must be last) ──────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────
// Start server + AI poller
// On Vercel (serverless), we skip app.listen() and the poller
// because Vercel manages the port and functions are ephemeral.
// The AI poller should run on a persistent server (local/VPS).
// ─────────────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log('');
    console.log('  ██╗   ██╗██╗███████╗██╗ ██████╗ ███╗   ██╗');
    console.log('  ██║   ██║██║██╔════╝██║██╔═══██╗████╗  ██║');
    console.log('  ██║   ██║██║███████╗██║██║   ██║██╔██╗ ██║');
    console.log('  ╚██╗ ██╔╝██║╚════██║██║██║   ██║██║╚██╗██║');
    console.log('   ╚████╔╝ ██║███████║██║╚██████╔╝██║ ╚████║');
    console.log('    ╚═══╝  ╚═╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝');
    console.log('');
    console.log(`  🚌 Vision Guard API — running on port ${PORT}`);
    console.log(`  📡 Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`  🗄️  Database   : Supabase`);
    console.log('');

    // Start the AI poller automatically on server boot
    try {
      await startPoller();
      console.log('  ✅ AI Poller started successfully');
    } catch (err) {
      console.warn('  ⚠️  AI Poller failed to start:', err.message);
      console.warn('     Use POST /api/ai/start to retry after setting the URL.');
    }

    console.log('');
    console.log('  Available routes:');
    console.log('   GET  /health');
    console.log('   GET  /api/dashboard/summary');
    console.log('   GET  /api/drivers');
    console.log('   GET  /api/violations');
    console.log('   GET  /api/routes');
    console.log('   GET  /api/reports/kpis');
    console.log('   GET  /api/settings/all');
    console.log('   PUT  /api/ai/config   ← update Cloudflare Tunnel URL here');
    console.log('   GET  /api/ai/status');
    console.log('   POST /api/penalties/:violationId');
    console.log('   GET  /api/fine-amounts');
    console.log('');
  });
}

// Export the Express app for Vercel's serverless handler
module.exports = app;

