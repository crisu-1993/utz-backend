// src/routes/resumenSemanalDisparo.js
//
// Endpoint de disparo MANUAL del resumen semanal (para testing end-to-end).
// Calcula la semana anterior, genera el resumen, lo persiste y lo devuelve.
// El cron (3b-2) reusará la misma lógica de generar+persistir.

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { calcularRangoAnterior } = require('../utils/periodos');
const { generarResumenSemanal } = require('../services/resumenSemanal');

const { authMiddleware } = require('../middleware/auth');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Generar + persistir un resumen semanal para una empresa ──────────────
// Función reutilizable (la usará también el cron en 3b-2).
async function generarYPersistir(supabase, empresa_id) {
  const rango = calcularRangoAnterior('semana');  // semana lunes-domingo recién cerrada
  const { mensaje, datos } = await generarResumenSemanal(
    supabase, empresa_id, rango.fecha_inicio, rango.fecha_fin
  );

  const fila = {
    empresa_id,
    fecha_inicio:       datos.fecha_inicio,
    fecha_fin:          datos.fecha_fin,
    entraron:           datos.entraron,
    salieron:           datos.salieron,
    resultado:          datos.resultado,
    resultado_anterior: datos.anterior ? datos.anterior.resultadoAnt : null,
    mensaje,
    canal:              'app',
  };

  // upsert anti-duplicado: si ya existe (empresa+rango), no crea otro
  const { data, error } = await supabase
    .from('resumenes_semanales')
    .upsert(fila, { onConflict: 'empresa_id,fecha_inicio,fecha_fin' })
    .select()
    .single();

  if (error) throw error;
  return { fila: data, mensaje, datos };
}

// ─── POST /api/resumen-semanal/disparar/:empresa_id ───────────────────────
router.post('/disparar/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaDelToken } = req.auth;
  const { empresa_id }                  = req.params;

  if (empresaDelToken !== empresa_id) {
    return res.status(403).json({ ok: false, error: 'Sin autorización para esta empresa' });
  }

  try {
    const supabase = getSupabase();
    const { fila, mensaje, datos } = await generarYPersistir(supabase, empresa_id);
    return res.json({ ok: true, persistido: fila, mensaje, datos });
  } catch (err) {
    console.error('[RESUMEN-DISPARO] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.generarYPersistir = generarYPersistir;
