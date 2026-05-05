'use strict';

// ─── Rutas /api/empresas ──────────────────────────────────────────────────────
//
// Usa authSoloMiddleware (no authMiddleware) porque estos endpoints no requieren
// que el usuario ya tenga empresa. Por ejemplo, un usuario recién registrado
// puede llamar a GET / y recibir una lista vacía sin error.
//
// Endpoints:
//   GET /api/empresas → lista todas las empresas del usuario autenticado

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authSoloMiddleware } = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── GET /api/empresas ────────────────────────────────────────────────────────
// Lista todas las empresas cuyo owner_id coincide con el user del JWT.
// Ordenadas de más antigua a más nueva (misma lógica que el fallback del authMiddleware).
// Si el usuario no tiene empresas devuelve lista vacía (no error).
router.get('/', authSoloMiddleware, async (req, res) => {
  const { user_id } = req.auth;
  const supabase    = getSupabase();

  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('id, nombre, created_at')
      .eq('owner_id', user_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[empresas] Error consultando empresas:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok:   true,
      data: data || [],
    });

  } catch (err) {
    console.error('[empresas] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
