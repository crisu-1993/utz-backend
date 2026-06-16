require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { sincronizarTodasLasEmpresas } = require('./src/services/fintocService');
const { generarRecordatoriosTributarios } = require('./src/services/recordatoriosTributarios');
const { generarRecordatoriosFeriados } = require('./src/services/recordatoriosFeriados');
const { createClient } = require('@supabase/supabase-js');

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
app.use('/api/niko-v2',           require('./src/routes/nikoV2'));   // ← V2 paralela (switch en Bloque 10)
app.use('/api/recordatorios',     require('./src/routes/recordatorios'));
app.use('/api/categorias',        require('./src/routes/categorias'));
app.use('/api/notificaciones-config', require('./src/routes/notificacionesConfig'));

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

  // Cron tributario: genera recordatorios de obligaciones (F29, Previred, F22) cada 12 horas.
  // Corre una vez al arrancar (fire-and-forget) y luego cada 12h.
  // Aislado: un error acá NUNCA debe tumbar el server ni afectar el cron de Fintoc.
  const INTERVALO_TRIBUTARIO_MS = 12 * 60 * 60 * 1000; // 12 horas
  const supabaseTributario = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Corrida inmediata al arranque (fire-and-forget con .catch para no bloquear el boot)
  generarRecordatoriosTributarios(supabaseTributario).catch((err) => {
    console.error('[tributario-cron] Error en corrida inicial:', err.message);
  });

  // Cron cada 12h
  setInterval(async () => {
    try {
      await generarRecordatoriosTributarios(supabaseTributario);
    } catch (err) {
      console.error('[tributario-cron] Error no capturado en cron:', err.message);
    }
  }, INTERVALO_TRIBUTARIO_MS);

  console.log(`[tributario-cron] Cron tributario activo (cada ${INTERVALO_TRIBUTARIO_MS / 3600000} h)`);

  // Cron feriados: avisa de feriados de la semana siguiente cada 24 horas.
  // Corre una vez al arrancar (fire-and-forget) y luego cada 24h.
  // Aislado: un error acá NUNCA debe tumbar el server ni afectar los otros crons.
  const INTERVALO_FERIADOS_MS = 24 * 60 * 60 * 1000; // 24 horas
  const supabaseFeriados = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Corrida inmediata al arranque (fire-and-forget con .catch para no bloquear el boot)
  generarRecordatoriosFeriados(supabaseFeriados).catch((err) => {
    console.error('[feriados-cron] Error en corrida inicial:', err.message);
  });

  // Cron cada 24h
  setInterval(async () => {
    try {
      await generarRecordatoriosFeriados(supabaseFeriados);
    } catch (err) {
      console.error('[feriados-cron] Error no capturado en cron:', err.message);
    }
  }, INTERVALO_FERIADOS_MS);

  console.log(`[feriados-cron] Cron de feriados activo (cada ${INTERVALO_FERIADOS_MS / 3600000} h)`);
});
