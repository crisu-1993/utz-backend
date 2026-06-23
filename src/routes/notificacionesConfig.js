'use strict';

// ─── Rutas /api/notificaciones-config ────────────────────────────────────────
//
// Endpoints:
//   GET /api/notificaciones-config/:empresa_id
//     → Devuelve la config de notificaciones de la empresa.
//       Si no existe aun, devuelve null (no crea fila).
//
//   PUT /api/notificaciones-config/:empresa_id
//     → Upsert de la config. Body: { tipo, activo, dia_envio, hora_envio, canal }
//       tipo y dia_envio son requeridos. El resto tiene defaults en la tabla.

const express          = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Tipos válidos de notificación (espejo del CHECK en la tabla)
const TIPOS_VALIDOS = new Set(['resumen_semanal', 'informe_mensual']);

// Canales válidos
const CANALES_VALIDOS = new Set(['app', 'whatsapp']);

// ─── GET /api/notificaciones-config/:empresa_id ───────────────────────────────
//
// Devuelve la config de la empresa para todos los tipos registrados.
// Si no hay filas, devuelve data: [].

router.get('/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaDelToken } = req.auth;
  const { empresa_id }                  = req.params;

  // Verificar que el usuario solo consulta su propia empresa
  if (empresaDelToken !== empresa_id) {
    return res.status(403).json({ ok: false, error: 'Sin autorización para esta empresa' });
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('notificaciones_config')
    .select('id, tipo, activo, dia_envio, hora_envio, canal, created_at, updated_at')
    .eq('empresa_id', empresa_id)
    .order('tipo');

  if (error) {
    console.error('[notificaciones-config] GET error:', error.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener configuración' });
  }

  return res.json({ ok: true, data });
});

// ─── PUT /api/notificaciones-config/:empresa_id ───────────────────────────────
//
// Upsert por (empresa_id, tipo). Crea la fila si no existe; la actualiza si ya existe.
//
// Body esperado:
//   {
//     tipo:       string   — 'resumen_semanal' (requerido)
//     dia_envio:  number   — 1=lunes .. 7=domingo (requerido)
//     hora_envio: string   — 'HH:MM' o 'HH:MM:SS' (requerido)
//     activo:     boolean  — default true
//     canal:      string   — 'app' | 'whatsapp', default 'app'
//   }

router.put('/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaDelToken } = req.auth;
  const { empresa_id }                  = req.params;

  // Verificar que el usuario solo modifica su propia empresa
  if (empresaDelToken !== empresa_id) {
    return res.status(403).json({ ok: false, error: 'Sin autorización para esta empresa' });
  }

  const { tipo, activo, dia_envio, hora_envio, canal } = req.body;

  // ── Validaciones ──────────────────────────────────────────────────────────

  if (!tipo || !TIPOS_VALIDOS.has(tipo)) {
    return res.status(400).json({
      ok: false,
      error: `tipo inválido. Valores permitidos: ${[...TIPOS_VALIDOS].join(', ')}`,
    });
  }

  const diaNum = Number(dia_envio);
  if (!Number.isInteger(diaNum) || diaNum < 1 || diaNum > 7) {
    return res.status(400).json({
      ok: false,
      error: 'dia_envio inválido. Debe ser un entero entre 1 (lunes) y 7 (domingo)',
    });
  }

  if (!hora_envio || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(hora_envio)) {
    return res.status(400).json({
      ok: false,
      error: "hora_envio inválida. Formato esperado: 'HH:MM' o 'HH:MM:SS'",
    });
  }

  const canalFinal = canal ?? 'app';
  if (!CANALES_VALIDOS.has(canalFinal)) {
    return res.status(400).json({
      ok: false,
      error: `canal inválido. Valores permitidos: ${[...CANALES_VALIDOS].join(', ')}`,
    });
  }

  const activoFinal = activo !== undefined ? Boolean(activo) : true;

  // ── Upsert ────────────────────────────────────────────────────────────────

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('notificaciones_config')
    .upsert(
      {
        empresa_id,
        tipo,
        activo:     activoFinal,
        dia_envio:  diaNum,
        hora_envio: hora_envio,
        canal:      canalFinal,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'empresa_id,tipo' }
    )
    .select('id, tipo, activo, dia_envio, hora_envio, canal, created_at, updated_at')
    .single();

  if (error) {
    console.error('[notificaciones-config] PUT error:', error.message);
    return res.status(500).json({ ok: false, error: 'Error al guardar configuración' });
  }

  return res.json({ ok: true, data });
});

module.exports = router;
