'use strict';

// ─── Rutas Fintoc — /api/fintoc ───────────────────────────────────────────────
//
// Endpoints:
//   GET    /api/fintoc/widget-config     → configuración para el widget del frontend
//   GET    /api/fintoc/health            → verifica conexión con Fintoc API
//   POST   /api/fintoc/links             → registrar link del widget + primera sync
//   GET    /api/fintoc/links             → listar links activos de la empresa
//   DELETE /api/fintoc/links/:link_id    → desactivar link (estado='revoked')
//   POST   /api/fintoc/sync/:link_id     → forzar sincronización manual
//   GET    /api/fintoc/sync/status/:empresa_id → estado del último sync

const express      = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  registrarLink,
  listarLinks,
  desactivarLink,
  sincronizarLink,
  obtenerEstadoUltimoSync,
  healthCheck,
} = require('../services/fintocService');

const router = express.Router();

// ─── GET /api/fintoc/widget-config ────────────────────────────────────────────
// Devuelve la configuración pública para inicializar el widget de Fintoc.
// Evita hardcodear FINTOC_PUBLIC_KEY en el frontend.
router.get('/widget-config', authMiddleware, (_req, res) => {
  return res.json({
    ok:           true,
    publicKey:    process.env.FINTOC_PUBLIC_KEY,
    holderType:   'business',
    country:      'cl',
    product:      'movements',
  });
});

// ─── GET /api/fintoc/health ───────────────────────────────────────────────────
// Verifica que la conexión con Fintoc API funciona correctamente.
// Útil para debugging en sandbox.
router.get('/health', authMiddleware, async (_req, res) => {
  const resultado = await healthCheck();

  if (resultado.ok) {
    return res.json({
      ok:             true,
      fintoc_status:  'connected',
    });
  } else {
    return res.status(502).json({
      ok:             false,
      fintoc_status:  'error',
      error:          'No se pudo conectar con Fintoc API',
    });
  }
});

// ─── POST /api/fintoc/links ───────────────────────────────────────────────────
// Registra un link_token del widget de Fintoc.
// Guarda el link en la BD y dispara la primera sincronización en background.
// Body: { link_token: string }
router.post('/links', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { link_token } = req.body;

  if (!link_token) {
    return res.status(400).json({ ok: false, error: 'Falta campo requerido: link_token' });
  }

  // Registrar link en BD (llama a Fintoc API para obtener datos del link)
  const resultado = await registrarLink(link_token, empresa_id);

  if (!resultado.ok) {
    return res.status(502).json({
      ok:    false,
      error: resultado.error || 'Error registrando link con Fintoc',
    });
  }

  const linkData = resultado.data;

  // Responder inmediatamente al frontend
  res.json({
    ok: true,
    link: {
      id:            linkData.fintoc_link_id,
      banco_nombre:  linkData.banco_nombre,
      cuenta_numero: linkData.cuenta_numero,
      estado:        linkData.estado,
    },
    mensaje: 'Conexión bancaria exitosa. Sincronizando movimientos...',
  });

  // Disparar primera sincronización en background (sin bloquear la respuesta)
  setImmediate(async () => {
    console.log(`[fintoc] iniciando primera sincronización para link ${linkData.fintoc_link_id}`);
    await sincronizarLink(linkData.fintoc_link_id, 'primera_sync').catch(err => {
      console.error('[fintoc] error en primera sincronización background:', err.message);
    });
  });
});

// ─── GET /api/fintoc/links ────────────────────────────────────────────────────
// Lista todos los links (de cualquier estado) de la empresa autenticada.
router.get('/links', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;

  const resultado = await listarLinks(empresa_id);

  if (!resultado.ok) {
    return res.status(500).json({ ok: false, error: resultado.error });
  }

  return res.json({
    ok:    true,
    links: resultado.data,
    total: resultado.data.length,
  });
});

// ─── DELETE /api/fintoc/links/:link_id ───────────────────────────────────────
// Desactiva un link (soft delete: estado='revoked').
// :link_id corresponde al valor de la columna fintoc_link_id (no el UUID interno).
router.delete('/links/:link_id', authMiddleware, async (req, res) => {
  const { empresa_id }   = req.auth;
  const { link_id }      = req.params;

  const resultado = await desactivarLink(link_id, empresa_id);

  if (!resultado.ok) {
    return res.status(400).json({ ok: false, error: resultado.error });
  }

  return res.json({
    ok:      true,
    mensaje: `Link ${link_id} desactivado correctamente`,
  });
});

// ─── POST /api/fintoc/sync/:link_id ──────────────────────────────────────────
// Fuerza una sincronización manual de un link específico.
// :link_id corresponde al valor de la columna fintoc_link_id.
router.post('/sync/:link_id', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { link_id }    = req.params;

  // Verificar que el link pertenece a esta empresa antes de sincronizar
  const links = await listarLinks(empresa_id);
  const linkValido = links.ok && links.data.some(l => l.fintoc_link_id === link_id);

  if (!linkValido) {
    return res.status(404).json({
      ok:    false,
      error: 'Link no encontrado o no pertenece a esta empresa',
    });
  }

  const resultado = await sincronizarLink(link_id, 'manual');

  if (!resultado.ok) {
    return res.status(500).json({ ok: false, error: resultado.error });
  }

  return res.json({
    ok:   true,
    sync: resultado.data,
  });
});

// ─── GET /api/fintoc/sync/status/:empresa_id ─────────────────────────────────
// Devuelve el estado del último sync y resumen de links de la empresa.
// Nota: valida que el empresa_id del parámetro coincida con el del token.
router.get('/sync/status/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaDelToken } = req.auth;
  const { empresa_id }                  = req.params;

  // Verificar que el usuario solo consulta su propia empresa
  if (empresaDelToken !== empresa_id) {
    return res.status(403).json({ ok: false, error: 'Sin autorización para esta empresa' });
  }

  const resultado = await obtenerEstadoUltimoSync(empresa_id);

  if (!resultado.ok) {
    return res.status(500).json({ ok: false, error: resultado.error });
  }

  return res.json({
    ok:          true,
    ultimo_sync: resultado.ultimo_sync,
    links:       resultado.links,
  });
});

module.exports = router;
