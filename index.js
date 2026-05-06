require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { sincronizarTodasLasEmpresas } = require('./src/services/fintocService');

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
app.use('/api/insights',          require('./src/routes/insights'));
app.use('/api/fintoc',            require('./src/routes/fintoc'));
app.use('/api/empresas',          require('./src/routes/empresas'));
app.use('/api/niko',              require('./src/routes/niko'));

app.listen(PORT, () => {
  console.log(`UTZ Backend escuchando en http://localhost:${PORT}`);

  // Polling Fintoc: sincronizar todos los links activos cada 60 minutos
  const INTERVALO_MS = 60 * 60 * 1000;  // 1 hora
  setInterval(async () => {
    try {
      await sincronizarTodasLasEmpresas();
    } catch (err) {
      console.error('[fintoc-cron] Error no capturado en polling:', err.message);
    }
  }, INTERVALO_MS);

  console.log(`[fintoc-cron] Polling de sincronización activo (cada ${INTERVALO_MS / 60000} min)`);
});
