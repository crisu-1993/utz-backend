'use strict';

// ─── Rutas /api/niko ──────────────────────────────────────────────────────────
//
// Endpoints:
//   POST /api/niko/chat → envía un mensaje a Niko y recibe su respuesta
//
// Body:
//   { mensaje: string, historial?: Array<{ role: 'user'|'assistant', content: string }> }

const express                    = require('express');
const { createClient }           = require('@supabase/supabase-js');
const { authMiddleware }         = require('../middleware/auth');
const { chatWithNiko }           = require('../services/niko/nikoService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const router = express.Router();

const MAX_HISTORIAL = 50;
const ROLES_VALIDOS = new Set(['user', 'assistant']);

// ─── POST /api/niko/chat ──────────────────────────────────────────────────────
// Body: { mensaje: string, historial?: Array }
// Requiere: Authorization: Bearer <token>
router.post('/chat', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { mensaje, historial: rawHistorial } = req.body || {};

  // Validar mensaje
  if (!mensaje || !String(mensaje).trim()) {
    return res.status(400).json({
      ok:    false,
      error: 'El campo "mensaje" es requerido y no puede estar vacío',
    });
  }

  // Validar y normalizar historial
  let historial = [];

  if (rawHistorial !== undefined) {
    if (!Array.isArray(rawHistorial)) {
      return res.status(400).json({
        ok:    false,
        error: 'El campo "historial" debe ser un array',
      });
    }

    if (rawHistorial.length > MAX_HISTORIAL) {
      return res.status(400).json({
        ok:    false,
        error: `El historial no puede superar ${MAX_HISTORIAL} mensajes`,
      });
    }

    for (let i = 0; i < rawHistorial.length; i++) {
      const item = rawHistorial[i];
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ ok: false, error: `historial[${i}] debe ser un objeto` });
      }
      if (!ROLES_VALIDOS.has(item.role)) {
        return res.status(400).json({ ok: false, error: `historial[${i}].role debe ser 'user' o 'assistant'` });
      }
      if (typeof item.content !== 'string' || !item.content.trim()) {
        return res.status(400).json({ ok: false, error: `historial[${i}].content debe ser un string no vacío` });
      }
    }

    historial = rawHistorial.map(item => ({
      role:    item.role,
      content: String(item.content),
    }));
  }

  try {
    const { respuesta, modelo_usado, tokens_usados } = await chatWithNiko(
      empresa_id,
      String(mensaje).trim(),
      historial,
      user_id
    );

    // ── Verificar si Niko debe notificar EERR Ampliado ──
    let eerrAmpliado = false;

    const { data: empresaFlags } = await supabase
      .from('empresas')
      .select('eerr_ampliado_revelado, eerr_ampliado_niko_notificado')
      .eq('id', empresa_id)
      .single();

    if (
      empresaFlags?.eerr_ampliado_revelado &&
      !empresaFlags?.eerr_ampliado_niko_notificado
    ) {
      await supabase
        .from('empresas')
        .update({ eerr_ampliado_niko_notificado: true })
        .eq('id', empresa_id);

      eerrAmpliado = true;
    }

    return res.json({
      ok: true,
      respuesta,
      eerr_ampliado_recien_revelado: eerrAmpliado,
      meta: { modelo_usado, tokens_usados },
    });

  } catch (err) {
    console.error('[niko] Error en POST /chat:', err.message);
    return res.status(500).json({
      ok:    false,
      error: err.message || 'Error interno al procesar el mensaje',
    });
  }
});

module.exports = router;
