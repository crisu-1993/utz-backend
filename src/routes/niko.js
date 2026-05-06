'use strict';

// ─── Rutas /api/niko ──────────────────────────────────────────────────────────
//
// Endpoints:
//   POST /api/niko/chat → envía un mensaje a Niko y recibe su respuesta

const express                    = require('express');
const { authMiddleware }         = require('../middleware/auth');
const { chatWithNiko }           = require('../services/niko/nikoService');

const router = express.Router();

// ─── POST /api/niko/chat ──────────────────────────────────────────────────────
// Body: { mensaje: string }
// Requiere: Authorization: Bearer <token>
router.post('/chat', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { mensaje }             = req.body || {};

  // Validar mensaje
  if (!mensaje || !String(mensaje).trim()) {
    return res.status(400).json({
      ok:    false,
      error: 'El campo "mensaje" es requerido y no puede estar vacío',
    });
  }

  try {
    const { respuesta, modelo_usado, tokens_usados } = await chatWithNiko(
      empresa_id,
      String(mensaje).trim(),
      user_id
    );

    return res.json({
      ok: true,
      respuesta,
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
