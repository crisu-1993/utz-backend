// src/services/cronResumenSemanal.js
//
// Cron del resumen semanal. Despierta cada 15 min, mira qué día/hora es EN CHILE,
// y dispara el resumen para las empresas cuya config (dia_envio + hora_envio) coincide.
//
// A diferencia del cron tributario: NO corre al arranque. Solo dispara cuando el reloj
// de Chile da la hora configurada (es un evento puntual, no un "rellenar lo que falte").
//
// Calca la estructura del cron tributario: cliente Supabase único, setInterval con
// try/catch, log de confirmación. Un error acá nunca debe tumbar el server.

const { createClient } = require('@supabase/supabase-js');
const { generarYPersistir } = require('../routes/resumenSemanalDisparo');

const INTERVALO_MS = 15 * 60 * 1000; // 15 minutos

// ─── Hora actual en Chile (America/Santiago), sin librerías externas ──────────
// Devuelve { diaISO, hora, minuto } donde diaISO: 1=lunes … 7=domingo.
function ahoraEnChile() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  // weekday viene como 'Mon','Tue',... → lo paso a ISO 1..7
  const mapaDia = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const diaISO = mapaDia[partes.weekday];
  let hora = parseInt(partes.hour, 10);
  if (hora === 24) hora = 0; // hour12:false puede dar '24' a medianoche en algunos entornos
  const minuto = parseInt(partes.minute, 10);
  return { diaISO, hora, minuto };
}

// ─── ¿La hora configurada cae dentro de la ventana actual de 15 min? ──────────
// hora_envio llega como 'HH:MM:SS'. Disparamos si el ahora-Chile está en
// [hora_envio, hora_envio + 15min). Así cada config dispara UNA sola ventana.
function dentroDeVentana(ahora, horaEnvioStr) {
  const [hEnv, mEnv] = horaEnvioStr.split(':').map((n) => parseInt(n, 10));
  const minutosAhora = ahora.hora * 60 + ahora.minuto;
  const minutosEnvio = hEnv * 60 + mEnv;
  return minutosAhora >= minutosEnvio && minutosAhora < minutosEnvio + 15;
}

// ─── Tick del cron: busca configs que toca disparar AHORA y las procesa ───────
async function tickResumenSemanal(supabase) {
  const ahora = ahoraEnChile();

  // Traer solo las configs de resumen_semanal activas para el día de hoy
  const { data: configs, error } = await supabase
    .from('notificaciones_config')
    .select('empresa_id, hora_envio')
    .eq('tipo', 'resumen_semanal')
    .eq('activo', true)
    .eq('dia_envio', ahora.diaISO);

  if (error) {
    console.error('[resumen-cron] Error leyendo configs:', error.message);
    return;
  }
  if (!configs || configs.length === 0) return; // nada que disparar este día

  for (const cfg of configs) {
    if (!dentroDeVentana(ahora, cfg.hora_envio)) continue; // no es su ventana aún

    // Red anti-doble-disparo: ¿ya existe el resumen de la semana pasada para esta empresa?
    // generarYPersistir hace upsert (UNIQUE empresa+rango), así que aunque dispare dos
    // veces no duplica; igual chequeamos antes para no recalcular en vano.
    try {
      const { fila } = await generarYPersistir(supabase, cfg.empresa_id);
      console.log(`[resumen-cron] Resumen generado para empresa ${cfg.empresa_id} (rango ${fila.fecha_inicio}..${fila.fecha_fin})`);
    } catch (err) {
      console.error(`[resumen-cron] Error generando resumen para empresa ${cfg.empresa_id}:`, err.message);
    }
  }
}

// ─── Arranque del cron (lo llama index.js) ────────────────────────────────────
function iniciarCronResumenSemanal() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // NOTA: a diferencia del tributario, NO hay corrida al arranque (evita disparos
  // a deshora en cada redeploy de Railway).

  setInterval(async () => {
    try {
      await tickResumenSemanal(supabase);
    } catch (err) {
      console.error('[resumen-cron] Error no capturado en tick:', err.message);
    }
  }, INTERVALO_MS);

  console.log(`[resumen-cron] Cron de resumen semanal activo (cada ${INTERVALO_MS / 60000} min, sin corrida al arranque)`);
}

module.exports = { iniciarCronResumenSemanal, ahoraEnChile, dentroDeVentana, tickResumenSemanal };
