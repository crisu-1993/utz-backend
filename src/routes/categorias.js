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

// Secciones del EERR que corresponden a ingresos. Todo lo demás es egreso.
// Fuente de verdad única — usada en crearRegla y en /diagnostico.
const SECCIONES_INGRESO = new Set(['ingreso_principal', 'ingreso_secundario']);

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

// ─── crearRegla ───────────────────────────────────────────────────────────────
//
// Función pura: crea o actualiza una regla de categorización y aplica el patrón
// a todas las transacciones históricas existentes sin categorizar.
//
// @param {object} supabase  - cliente Supabase ya instanciado
// @param {object} params
//   @param {string}  empresa_id            - uuid requerido
//   @param {string}  patron                - texto requerido
//   @param {string}  categoria_nombre      - nombre del catálogo requerido
//   @param {string}  tipo_patron           - 'contiene'|'empieza_con'|'exacto'
//   @param {string}  creada_por            - 'usuario'|'niko' (hardcodeado por caller)
//   @param {string}  [descripcion_aprendida] - contexto opcional
//   @param {boolean} [dry_run=false]       - si true, solo cuenta sin insertar
//
// @returns {object} { ok, regla_id, transacciones_afectadas, dry_run, accion, mensaje }
//                   o { ok: false, error, codigo }

const TIPOS_PATRON_VALIDOS = ['contiene', 'empieza_con', 'exacto'];

function buildWherePatron(patron, tipo_patron) {
  // Escapar caracteres especiales de LIKE: % y _
  const escapado = patron
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');

  if (tipo_patron === 'contiene')     return `%${escapado}%`;
  if (tipo_patron === 'empieza_con')  return `${escapado}%`;
  return escapado;  // 'exacto'
}

async function crearRegla(supabase, params) {
  const {
    empresa_id,
    patron,
    categoria_nombre,
    tipo_patron,
    creada_por,
    descripcion_aprendida = null,
    dry_run               = false,
  } = params;

  // ── 1. Validar inputs ────────────────────────────────────────────────────
  if (!empresa_id)       return { ok: false, codigo: 'VALIDACION', error: 'empresa_id es requerido' };
  if (!patron?.trim())   return { ok: false, codigo: 'VALIDACION', error: 'patron es requerido' };
  if (!categoria_nombre) return { ok: false, codigo: 'VALIDACION', error: 'categoria_nombre es requerido' };
  if (!TIPOS_PATRON_VALIDOS.includes(tipo_patron)) {
    return { ok: false, codigo: 'VALIDACION', error: `tipo_patron inválido: '${tipo_patron}'` };
  }
  if (!['usuario', 'niko'].includes(creada_por)) {
    return { ok: false, codigo: 'VALIDACION', error: `creada_por inválido: '${creada_por}'` };
  }

  // ── 2. Construir WHERE para ILIKE ─────────────────────────────────────────
  const whereValue = buildWherePatron(patron.trim().toLowerCase(), tipo_patron);

  // ── 3. Resolver categoria_nombre → categoria_id (+ seccion_eerr para validación) ──
  const { data: catData, error: catErr } = await supabase
    .from('categorias_eerr')
    .select('id, seccion_eerr')
    .eq('empresa_id', empresa_id)
    .eq('nombre', categoria_nombre)
    .eq('activa', true)
    .maybeSingle();

  if (catErr) {
    console.error('[crearRegla] Error buscando categoría:', catErr.message);
    return { ok: false, codigo: 'DB_ERROR', error: 'Error al buscar la categoría' };
  }
  if (!catData) {
    return {
      ok:     false,
      codigo: 'CATEGORIA_NO_EXISTE',
      error:  `La categoría '${categoria_nombre}' no existe o no está activa para esta empresa`,
    };
  }
  const categoria_id   = catData.id;
  const esIngresoCat   = SECCIONES_INGRESO.has(catData.seccion_eerr);
  const tipoEsperado   = esIngresoCat ? 'ingreso' : 'egreso';
  const tipoOpuesto    = esIngresoCat ? 'egreso'  : 'ingreso';

  // ── 4. Obtener TODAS las transacciones que el patrón afectaría (sin filtro tipo) ──
  // Necesario para detectar incoherencias antes de ejecutar el UPDATE.
  const { data: txCandidatas, error: countErr } = await supabase
    .from('transacciones_historicas')
    .select('id, tipo, descripcion_normalizada')
    .eq('empresa_id', empresa_id)
    .is('categoria_id', null)
    .ilike('descripcion_normalizada', whereValue);

  const txCoherentes    = countErr ? [] : (txCandidatas || []).filter(t => t.tipo === tipoEsperado);
  const txIncoherentes  = countErr ? [] : (txCandidatas || []).filter(t => t.tipo === tipoOpuesto);
  const transacciones_afectadas = txCoherentes.length;

  // ── 5. DRY RUN ────────────────────────────────────────────────────────────
  if (dry_run) {
    return {
      ok:                      true,
      dry_run:                 true,
      accion:                  'simulada',
      regla_id:                null,
      transacciones_afectadas,
      mensaje: `Simulación: la regla afectaría a ${transacciones_afectadas} transacciones`,
    };
  }

  // ── 6a. Determinar si la regla ya existe (para saber accion) ─────────────
  const { data: existente } = await supabase
    .from('reglas_categorizacion')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('patron', patron.trim().toLowerCase())
    .eq('tipo_patron', tipo_patron)
    .maybeSingle();

  const accion = existente ? 'actualizada' : 'creada';

  // ── 6b. UPSERT en reglas_categorizacion ──────────────────────────────────
  const { data: upsertData, error: upsertErr } = await supabase
    .from('reglas_categorizacion')
    .upsert(
      {
        empresa_id,
        categoria_id,
        patron:                patron.trim().toLowerCase(),
        tipo_patron,
        descripcion_aprendida: descripcion_aprendida || null,
        creada_por,
        activa:                true,
      },
      { onConflict: 'empresa_id,patron,tipo_patron' }
    )
    .select('id')
    .single();

  if (upsertErr) {
    console.error('[crearRegla] Error en upsert:', upsertErr.message);
    return { ok: false, codigo: 'INSERT_FALLO', error: upsertErr.message };
  }

  const regla_id = upsertData.id;

  // ── 6c. UPDATE transacciones existentes (solo tipo coherente) ───────────────
  let warning;
  let txAfectadas = 0;
  let incoherencias_detectadas = null;

  const { data: txUpdated, error: updateErr } = await supabase
    .from('transacciones_historicas')
    .update({ categoria_id })
    .eq('empresa_id', empresa_id)
    .eq('tipo', tipoEsperado)
    .is('categoria_id', null)
    .ilike('descripcion_normalizada', whereValue)
    .select('id');

  if (updateErr) {
    console.error('[crearRegla] Error actualizando transacciones:', updateErr.message);
    warning     = `Regla guardada pero UPDATE de transacciones falló: ${updateErr.message}`;
    txAfectadas = 0;
  } else {
    txAfectadas = txUpdated?.length ?? 0;
  }

  // ── 6d. Detectar y reportar incoherencias de tipo ─────────────────────────
  if (txIncoherentes.length > 0) {
    const ejemplos = txIncoherentes
      .slice(0, 3)
      .map(t => t.descripcion_normalizada)
      .filter(Boolean);

    incoherencias_detectadas = {
      tipo_opuesto_count: txIncoherentes.length,
      tipo_categoria:     tipoEsperado,
      ejemplos,
      mensaje_para_niko:
        `Apliqué la regla a ${txAfectadas} transacción(es) de tipo ${tipoEsperado}. ` +
        `Detecté ${txIncoherentes.length} transacción(es) de tipo ${tipoOpuesto} con el mismo patrón ` +
        `que NO categoricé porque la categoría '${categoria_nombre}' es de ${tipoEsperado}s. ` +
        `Pregunta al usuario cómo quiere categorizar esas ${txIncoherentes.length} transacción(es).`,
    };
  }

  // ── 7. Actualizar visibilidad de categoría ───────────────────────────────
  const { data: catActual } = await supabase
    .from('categorias_eerr')
    .select('primera_vez_usada_at')
    .eq('id', categoria_id)
    .single();

  await supabase
    .from('categorias_eerr')
    .update({
      ultimo_movimiento_at: new Date().toISOString(),
      primera_vez_usada_at: catActual?.primera_vez_usada_at
        ?? new Date().toISOString()
    })
    .eq('id', categoria_id)
    .eq('empresa_id', empresa_id);

  // ── 8. Verificar si revelar EERR Ampliado ────────────────────────────────
  // Threshold: 5 reglas aprendidas = Niko conoce el negocio
  let eerrAmpliado = false;

  const { count: totalReglas } = await supabase
    .from('reglas_categorizacion')
    .select('*', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id);

  if (totalReglas >= 5) {
    // Verificar si ya fue revelado
    const { data: empresaFlag } = await supabase
      .from('empresas')
      .select('eerr_ampliado_revelado')
      .eq('id', empresa_id)
      .single();

    if (!empresaFlag?.eerr_ampliado_revelado) {
      // Activar flag
      await supabase
        .from('empresas')
        .update({
          eerr_ampliado_revelado:    true,
          eerr_ampliado_revelado_at: new Date().toISOString(),
        })
        .eq('id', empresa_id);

      eerrAmpliado = true;
    }
  }

  // ── 9. Retornar ───────────────────────────────────────────────────────────
  const resultado = {
    ok:                      true,
    dry_run:                 false,
    accion,
    regla_id,
    transacciones_afectadas: txAfectadas,
    mensaje: `Regla ${accion}: ${txAfectadas} transacciones categorizadas como '${categoria_nombre}'`,
  };
  if (warning)                resultado.warning                        = warning;
  if (eerrAmpliado)           resultado.eerr_ampliado_recien_revelado  = true;
  if (incoherencias_detectadas) resultado.incoherencias_detectadas     = incoherencias_detectadas;

  return resultado;
}

// ─── POST /crear-regla ────────────────────────────────────────────────────────
//
// Body: { empresa_id, patron, categoria_nombre, tipo_patron,
//         descripcion_aprendida?, dry_run? }
// Auth: el usuario debe ser owner de la empresa.
// creada_por siempre 'usuario' — nunca aceptado del body.

router.post('/crear-regla', authMiddleware, async (req, res) => {
  const { user_id } = req.auth;
  const {
    empresa_id,
    patron,
    categoria_nombre,
    tipo_patron,
    descripcion_aprendida,
    dry_run = false,
  } = req.body;

  const supabase = getSupabase();

  try {
    // ── 1. Validar ownership de empresa ───────────────────────────────────
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', empresa_id)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[crear-regla] Error validando empresa:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre esa empresa' });
    }

    // ── 2. Llamar función pura ─────────────────────────────────────────────
    const resultado = await crearRegla(supabase, {
      empresa_id,
      patron,
      categoria_nombre,
      tipo_patron,
      descripcion_aprendida,
      dry_run,
      creada_por: 'usuario',   // hardcodeado — nunca del body
    });

    // ── 3. Mapear código de error a HTTP status ────────────────────────────
    if (!resultado.ok) {
      const status = resultado.codigo === 'CATEGORIA_NO_EXISTE' || resultado.codigo === 'VALIDACION'
        ? 400
        : 500;
      return res.status(status).json(resultado);
    }

    return res.json(resultado);

  } catch (err) {
    console.error('[crear-regla] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ─── GET /diagnostico/:empresa_id ────────────────────────────────────────────
//
// Endpoint solo-lectura. Detecta:
//   A) Transacciones con categoria_id asignado pero cuyo tipo no coincide
//      con el tipo derivado de categorias_eerr.seccion_eerr (incoherentes).
//   B) Transacciones sin categoria_id, agrupadas por tipo.
//
// Respuesta:
//   {
//     ok: true,
//     empresa_id: "...",
//     incoherentes: { total: N, items: [...] },
//     sin_categorizar: { ingresos: N, egresos: M, total: N+M }
//   }

router.get('/diagnostico/:empresa_id', authMiddleware, async (req, res) => {
  const { empresa_id: empresaId } = req.params;
  const { user_id }               = req.auth;

  const supabase = getSupabase();

  try {
    // ── 1. Validar ownership de empresa ──────────────────────────────────────
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', empresaId)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[diagnostico] Error validando empresa:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre esa empresa' });
    }

    // ── 2. Queries en paralelo ────────────────────────────────────────────────
    const [txsResult, catsResult, sinCatResult] = await Promise.all([
      // A) Transacciones con categoria_id asignado (candidatas a incoherencia)
      supabase
        .from('transacciones_historicas')
        .select('id, fecha_transaccion, descripcion_normalizada, monto_original, tipo, categoria_id')
        .eq('empresa_id', empresaId)
        .not('categoria_id', 'is', null)
        .order('fecha_transaccion', { ascending: false })
        .limit(200),

      // Catálogo de categorías de la empresa (para join en JS)
      supabase
        .from('categorias_eerr')
        .select('id, nombre, seccion_eerr')
        .eq('empresa_id', empresaId),

      // B) Transacciones sin categoria_id (solo tipo, para conteo)
      supabase
        .from('transacciones_historicas')
        .select('tipo')
        .eq('empresa_id', empresaId)
        .is('categoria_id', null),
    ]);

    if (txsResult.error) {
      console.error('[diagnostico] Error consultando transacciones:', txsResult.error.message);
      return res.status(500).json({ ok: false, error: 'Error al consultar transacciones' });
    }
    if (catsResult.error) {
      console.error('[diagnostico] Error consultando categorías:', catsResult.error.message);
      return res.status(500).json({ ok: false, error: 'Error al consultar categorías' });
    }
    if (sinCatResult.error) {
      console.error('[diagnostico] Error consultando sin categoría:', sinCatResult.error.message);
      return res.status(500).json({ ok: false, error: 'Error al consultar transacciones sin categoría' });
    }

    // ── 3. Caso A — detectar incoherencias (join + filtro en JS) ─────────────
    const catMap = Object.fromEntries((catsResult.data || []).map(c => [c.id, c]));

    const itemsIncoherentes = (txsResult.data || [])
      .filter(tx => {
        const cat = catMap[tx.categoria_id];
        if (!cat) return false;
        const tipoEsperado = SECCIONES_INGRESO.has(cat.seccion_eerr) ? 'ingreso' : 'egreso';
        return tx.tipo !== tipoEsperado;
      })
      .map(tx => {
        const cat = catMap[tx.categoria_id];
        const tipoEsperado = SECCIONES_INGRESO.has(cat.seccion_eerr) ? 'ingreso' : 'egreso';
        return {
          id:                  tx.id,
          fecha:               tx.fecha_transaccion,
          descripcion:         tx.descripcion_normalizada,
          monto:               tx.monto_original,
          tipo_transaccion:    tx.tipo,
          categoria_id:        tx.categoria_id,
          categoria_nombre:    cat.nombre,
          seccion_eerr_actual: cat.seccion_eerr,
          tipo_esperado:       tipoEsperado,
        };
      });

    // ── 4. Caso B — conteo sin categorizar por tipo ───────────────────────────
    const sinCat      = sinCatResult.data || [];
    const ingSinCat   = sinCat.filter(t => t.tipo === 'ingreso').length;
    const egrSinCat   = sinCat.filter(t => t.tipo === 'egreso').length;

    return res.json({
      ok:         true,
      empresa_id: empresaId,
      incoherentes: {
        total: itemsIncoherentes.length,
        items: itemsIncoherentes,
      },
      sin_categorizar: {
        ingresos: ingSinCat,
        egresos:  egrSinCat,
        total:    ingSinCat + egrSinCat,
      },
    });

  } catch (err) {
    console.error('[diagnostico] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

module.exports                        = router;
module.exports.detectarPatrones       = detectarPatrones;
module.exports.extraerPatronClave     = extraerPatronClave;
module.exports.calcularScore          = calcularScore;
module.exports.crearRegla             = crearRegla;
