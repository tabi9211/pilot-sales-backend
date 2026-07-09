require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { apiLimiter } = require('./middleware/rateLimiters');
const authRoutes = require('./routes/auth');
const leadsRoutes = require('./routes/leads');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));

app.use(express.json());
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRoutes);

// Never leak stack traces to the client
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Sales pilot API listening on port ${port}`);
});
