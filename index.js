require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'UTZ Backend corriendo',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/documents',         require('./src/routes/documents'));
app.use('/api/webhooks',          require('./src/routes/webhooks'));
app.use('/api/estado-resultados', require('./src/routes/estadoResultados'));
app.use('/api/resumen',           require('./src/routes/resumen'));
app.use('/api/score',             require('./src/routes/score'));

app.listen(PORT, () => {
  console.log(`UTZ Backend escuchando en http://localhost:${PORT}`);
});
