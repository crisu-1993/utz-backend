'use strict';

// ─── Rutas /api/niko-v2 ───────────────────────────────────────────────────────
//
// Endpoint paralelo para Niko V2 (multi-agente).
// Expone únicamente POST /chat — apunta a chatWithNikoStreamV2.
// Los demás endpoints del monolito (verificar-recordatorio, historial,
// recordatorios) siguen en /api/niko hasta el switch final (Bloque 10).
//
// DIFERENCIA con niko.js: require + llamada a chatWithNikoStreamV2.
// TODO lo demás (SSE, idempotencia, validaciones, persistencia user) es idéntico.

const express                       = require('express');
const { createClient }              = require('@supabase/supabase-js');
const { authMiddleware }            = require('../middleware/auth');
const { chatWithNikoStreamV2 }      = require('../services/niko/nikoServiceV2');  // ← V2
const {
  obtenerRequestId,
  verificarOMarcar,
  marcarFinalizado,
  limpiarEntrada,
} = require('../middleware/idempotencia');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const router = express.Router();

const MAX_HISTORIAL = 50;
const ROLES_VALIDOS = new Set(['user', 'assistant']);

// ─── POST /api/niko-v2/chat ───────────────────────────────────────────────────
// Body: { mensaje: string, historial?: Array }
// Requiere: Authorization: Bearer <token>
// Respuesta: Server-Sent Events (text/event-stream)
//
// Eventos SSE emitidos:
//   event: delta      → { texto: string }
//   event: tool_start → { tool: string, input: object }
//   event: tool_end   → { ok: bool, mensaje: string }
//   event: done       → { respuesta, eerr_ampliado_recien_revelado, meta, saturado }
//   event: error      → { error: string }

router.post('/chat', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;

  // ─── Idempotencia ─────────────────────────────────────────────────────────
  const requestId = obtenerRequestId(req);
  console.log('[idempotencia] POST /api/niko-v2/chat | requestId:', requestId || '(sin id)');

  if (requestId) {
    const check = verificarOMarcar(requestId);
    if (check.duplicado) {
      console.log('[idempotencia] Request DUPLICADO ignorado:', requestId, '| enCurso:', check.enCurso);
      return res.status(204).end();
    }
  }

  const { mensaje, historial: rawHistorial } = req.body || {};

  // ── Validaciones (antes de activar SSE) ───────────────────────────────────
  if (!mensaje || !String(mensaje).trim()) {
    return res.status(400).json({
      ok:    false,
      error: 'El campo "mensaje" es requerido y no puede estar vacío',
    });
  }

  let historial = [];

  if (rawHistorial !== undefined) {
    if (!Array.isArray(rawHistorial)) {
      return res.status(400).json({ ok: false, error: 'El campo "historial" debe ser un array' });
    }
    if (rawHistorial.length > MAX_HISTORIAL) {
      return res.status(400).json({ ok: false, error: `El historial no puede superar ${MAX_HISTORIAL} mensajes` });
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
    historial = rawHistorial.map(item => ({ role: item.role, content: String(item.content) }));
  }

  const mensajeTrimmed = String(mensaje).trim();

  // ── Activar SSE ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (eventName, dataObj) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
  };

  // Persistir mensaje del usuario (fire-and-forget, mismo esquema que monolito)
  supabase.from('niko_conversaciones').insert({
    empresa_id,
    user_id,
    rol:             'user',
    mensaje:         mensajeTrimmed,
    tools_invocadas: [],
  }).then(({ error }) => {
    if (error) console.error('[niko-v2/chat] Error persistiendo mensaje user:', error.message);
  });

  try {
    await chatWithNikoStreamV2({ mensaje: mensajeTrimmed, historial, empresa_id, user_id }, emit);  // ← V2
    if (requestId) marcarFinalizado(requestId);
  } catch (err) {
    if (requestId) limpiarEntrada(requestId);
    console.error('[niko-v2] Error catastrófico en POST /chat:', err.message);
    emit('error', { error: err.message || 'Error interno al procesar el mensaje' });
  } finally {
    res.end();
  }
});

module.exports = router;
