'use strict';

// ─── Rutas /api/categorias ────────────────────────────────────────────────────
//
// Endpoints:
//   GET /api/categorias/detectar-patrones/:empresa_id
//     → Detecta patrones repetidos en transacciones sin categoria_id
//       y devuelve candidatos ordenados por score para que Niko pregunte.

const express            = require('express');
const { createClient }   = require('@supabase/supabase-js');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ─── Configuración ────────────────────────────────────────────────────────────

const UMBRAL_MINIMO = 3;   // ocurrencias mínimas para incluir un patrón
const LIMIT_DEFAULT = 10;
const LIMIT_MAX     = 50;
const LIMIT_MIN     = 1;

// Palabras genéricas que no aportan identidad a una transacción.
// "redcompra" está EXCLUIDO intencionalmente — es un patrón válido
// que identifica compras con tarjeta débito en comercios.
const STOP_WORDS = new Set([
  // Acciones bancarias genéricas
  'transferencia', 'transf', 'pago', 'compra', 'transbank',
  'webpay', 'abono', 'deposito', 'tef', 'spi',
  // Artículos y preposiciones comunes en descripciones chilenas
  'de', 'del', 'el', 'la', 'los', 'las', 'en', 'por',
  'para', 'a', 'al', 'con', 'un', 'una',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

/**
 * Extrae la palabra clave (patrón) de una descripción normalizada.
 * Tokeniza por espacios, filtra stop words y tokens cortos o numéricos,
 * devuelve la primera palabra significativa restante.
 *
 * Ejemplos:
 *   "redcompra mall plaza trebol" → "redcompra"
 *   "transferencia juan perez"    → "juan"
 *   "tef 12345678"                → null  (solo stop word + número)
 *
 * @param {string|null} descripcion
 * @returns {string|null}
 */
function extraerPatronClave(descripcion) {
  if (!descripcion) return null;

  const tokens = descripcion.trim().toLowerCase().split(/\s+/);

  for (const token of tokens) {
    if (token.length < 3)        continue;   // muy corto
    if (STOP_WORDS.has(token))   continue;   // genérico
    if (/^\d+$/.test(token))     continue;   // solo números
    return token;
  }

  return null;
}

/**
 * Calcula el score 0-100 de un patrón detectado.
 *
 * Componentes:
 *   A) Frecuencia       (0-50 pts) → min(veces, 5) / 5 × 50
 *      3 veces = 30 pts, 4 = 40, 5+ = 50
 *   B) Monto relativo   (0-30 pts) → si el patrón representa ≥1% del
 *      total de la empresa = 30 pts completos
 *   C) Recurrencia temp (0-20 pts) → 20 pts si aparece en ≥2 meses distintos
 *
 * @param {{ veces: number, montoPatron: number, montoTotalEmpresa: number, mesesDistintos: number }}
 * @returns {number} entero 0-100
 */
function calcularScore({ veces, montoPatron, montoTotalEmpresa, mesesDistintos }) {
  const puntajeFreq     = Math.min(veces, 5) / 5 * 50;
  const proporcion      = montoTotalEmpresa > 0 ? montoPatron / montoTotalEmpresa : 0;
  const puntajeMonto    = Math.min(proporcion * 100, 1) * 30;
  const puntajeTemporal = mesesDistintos >= 2 ? 20 : 0;

  return Math.round(puntajeFreq + puntajeMonto + puntajeTemporal);
}

// ─── detectarPatrones ─────────────────────────────────────────────────────────
//
// Función pura: recibe un array de transacciones ya cargadas y devuelve los
// patrones detectados, ordenados por score DESC.
//
// Exportada para ser reutilizada por contextoFinanciero.js (Niko).
//
// @param {Array}  transacciones  - filas con campos:
//                                  id, descripcion_normalizada,
//                                  monto_original, tipo, fecha_transaccion
// @param {object} opts
// @param {number} opts.limit     - máximo resultados (default: sin límite)
// @param {number} opts.umbral    - ocurrencias mínimas (default: UMBRAL_MINIMO)
// @param {number} opts.scoreMin  - score mínimo para incluir (default: 0)
// @returns {Array}

function detectarPatrones(transacciones, { limit = Infinity, umbral = UMBRAL_MINIMO, scoreMin = 0 } = {}) {
  if (!transacciones || transacciones.length === 0) return [];

  const montoTotalEmpresa = transacciones.reduce(
    (acc, tx) => acc + Math.abs(tx.monto_original || 0),
    0
  );

  const mapa = {};

  for (const tx of transacciones) {
    const patron = extraerPatronClave(tx.descripcion_normalizada);
    if (!patron) continue;

    if (!mapa[patron]) {
      mapa[patron] = {
        patron,
        veces:             0,
        monto_total:       0,
        cantidad_ingresos: 0,
        cantidad_egresos:  0,
        meses:             new Set(),
        ejemplos:          [],
        ids:               [],
      };
    }

    const acum = mapa[patron];
    acum.veces       += 1;
    acum.monto_total += Math.abs(tx.monto_original || 0);

    if (tx.tipo === 'ingreso') acum.cantidad_ingresos += 1;
    else                       acum.cantidad_egresos  += 1;

    acum.meses.add((tx.fecha_transaccion || '').slice(0, 7));
    if (acum.ejemplos.length < 3) acum.ejemplos.push(tx.descripcion_normalizada);
    acum.ids.push(tx.id);
  }

  return Object.values(mapa)
    .filter(p => p.veces >= umbral)
    .map(p => {
      const score = calcularScore({
        veces:            p.veces,
        montoPatron:      p.monto_total,
        montoTotalEmpresa,
        mesesDistintos:   p.meses.size,
      });

      const tipo_predominante = p.cantidad_ingresos >= p.cantidad_egresos
        ? 'ingreso'
        : 'egreso';

      return {
        patron:               p.patron,
        veces_aparece:        p.veces,
        monto_total:          Math.round(p.monto_total),
        tipo_predominante,
        cantidad_ingresos:    p.cantidad_ingresos,
        cantidad_egresos:     p.cantidad_egresos,
        es_mixto:             p.cantidad_ingresos > 0 && p.cantidad_egresos > 0,
        score,
        ejemplos_descripcion: p.ejemplos,
        transacciones_ids:    p.ids,
      };
    })
    .filter(p => p.score >= scoreMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── GET /detectar-patrones/:empresa_id ──────────────────────────────────────
//
// Query params:
//   ?limit=N  (default 10, mín 1, máx 50)
//
// Respuesta 200:
//   {
//     ok: true,
//     empresa_id: "...",
//     total_sin_categorizar: 221,
//     patrones_detectados: [...],
//   }

router.get('/detectar-patrones/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaId } = req.params;
  const { user_id }               = req.auth;

  // ── Parsear y validar limit ────────────────────────────────────────────────
  let limit = parseInt(req.query.limit, 10);
  if (!limit || limit < LIMIT_MIN) limit = LIMIT_DEFAULT;
  if (limit > LIMIT_MAX)           limit = LIMIT_MAX;

  const supabase = getSupabase();

  try {
    // ── 1. Validar que la empresa pertenece al usuario autenticado ─────────
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', empresaId)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[categorias] Error validando empresa:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
    }

    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre esa empresa' });
    }

    // ── 2. Traer todas las transacciones sin categorizar ───────────────────
    const { data: transacciones, error: txErr } = await supabase
      .from('transacciones_historicas')
      .select('id, descripcion_normalizada, monto_original, tipo, fecha_transaccion')
      .eq('empresa_id', empresaId)
      .is('categoria_id', null)
      .not('descripcion_normalizada', 'is', null);

    if (txErr) {
      console.error('[categorias] Error consultando transacciones:', txErr.message);
      return res.status(500).json({ ok: false, error: 'Error al consultar transacciones' });
    }

    const totalSinCategorizar = transacciones.length;

    if (totalSinCategorizar === 0) {
      return res.json({
        ok:                    true,
        empresa_id:            empresaId,
        total_sin_categorizar: 0,
        patrones_detectados:   [],
      });
    }

    // ── 3. Detectar patrones (delega en función pura) ─────────────────────
    const patrones = detectarPatrones(transacciones, { limit });

    return res.json({
      ok:                    true,
      empresa_id:            empresaId,
      total_sin_categorizar: totalSinCategorizar,
      patrones_detectados:   patrones,
    });

  } catch (err) {
    console.error('[categorias] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

module.exports                        = router;
module.exports.detectarPatrones       = detectarPatrones;
module.exports.extraerPatronClave     = extraerPatronClave;
module.exports.calcularScore          = calcularScore;
