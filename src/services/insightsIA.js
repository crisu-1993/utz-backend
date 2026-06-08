'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// insightsIA.js — Servicio de Insights con IA para UTZ Finance
// ═══════════════════════════════════════════════════════════════════════════════
//
// Funciones puras y testeables para:
//   1. Evaluar si una empresa tiene datos suficientes para generar insights IA
//   2. Leer/escribir/borrar cache de insights (tabla insights_cache)
//   3. Construir el contexto financiero de un mes específico
//   4. Llamar a Claude para generar insights + recomendaciones
//
// NOTA: insights.js (routes) hoy solo exporta el router, no las funciones
// determinísticas individuales. El fallback determinístico se resuelve en
// el orquestador (Pieza 1.2.b) llamando al endpoint existente o exportando
// las funciones en ese paso.
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { obtenerContextoFinanciero } = require('./niko/contextoFinanciero');
const { calcularRangoMes, consultarPeriodo, variacionPct } = require('../utils/periodos');
const { generarDeterministico } = require('./insightsDeterministico');

const MODEL = 'claude-sonnet-4-6';

// ─── Prompt ──────────────────────────────────────────────────────────────────

const PROMPT_INSIGHTS_IA = `
# Identidad

Eres Niko, CFO con IA de una PYME chilena. Tuteas al dueño, lo llamas "jefe" cuando quieres enfatizar algo. Tono directo, brutal pero empático. Sin formalismo robótico, sin voseo argentino.

# Tarea

Analiza los datos financieros del mes que te paso y devuelve EXACTAMENTE 3 insights + 2 recomendaciones.

# Formato de salida

JSON ESTRICTO. Sin texto antes ni después. Sin code fences. Sin markdown. Solo el JSON:

{
  "insights": [
    { "id": "slug-corto", "titulo": "Titulo 3-7 palabras", "texto": "Observacion descriptiva", "tono": "positivo|neutro|atencion|negativo" },
    { "id": "slug-corto", "titulo": "Titulo 3-7 palabras", "texto": "Observacion descriptiva", "tono": "positivo|neutro|atencion|negativo" },
    { "id": "slug-corto", "titulo": "Titulo 3-7 palabras", "texto": "Observacion descriptiva", "tono": "positivo|neutro|atencion|negativo" }
  ],
  "recomendaciones": [
    { "id": "slug-corto", "titulo": "Titulo 3-7 palabras", "texto": "Accion sugerida", "tono": "positivo|neutro|atencion|negativo" },
    { "id": "slug-corto", "titulo": "Titulo 3-7 palabras", "texto": "Accion sugerida", "tono": "positivo|neutro|atencion|negativo" }
  ]
}

# Reglas

1. NO inventes datos. Solo usa las cifras que te paso. Si el mes anterior es null, NO compares con mes anterior. Si YoY es null, NO compares con año anterior.
2. Insights = lo que pasó (descriptivo, observacional). Recomendaciones = qué hacer (accionable, genérico — no "renegocia con proveedor X").
3. Cada texto entre 1 y 3 oraciones. Claro y conciso. Usa cifras concretas del contexto.
4. Tonos: "positivo" (buena noticia), "neutro" (informativo), "atencion" (alerta moderada, algo a mirar), "negativo" (alerta seria, problema claro).
5. Si los datos son escasos (pocas transacciones categorizadas, solo entradas brutas), da insights básicos con lo que hay y pon una recomendación de "categorizar más movimientos para tener mejor visibilidad".
6. Tutea siempre. Llama "jefe" al dueño cuando quieras dar énfasis. Sé directo y útil, no adornes.
7. Los ids deben ser slugs descriptivos en snake_case (ej: "margen_ajustado", "salidas_altas", "categorizar_pendientes").
8. EXACTAMENTE 3 insights y EXACTAMENTE 2 recomendaciones. Ni más ni menos.

# Datos del mes a analizar

{{CONTEXTO_MES}}
`;

// ─── 1. evaluarDatosSuficientes ──────────────────────────────────────────────

/**
 * Evalúa si la empresa tiene datos suficientes en un mes para generar insights IA.
 *
 * @param {string} empresa_id
 * @param {number} mes  - 1-12
 * @param {number} anio - YYYY
 * @param {object} supabase - cliente Supabase
 * @returns {Promise<{ suficientes: boolean, razon: string, totales: { total_tx, categorizadas, porcentaje_cat } }>}
 */
async function evaluarDatosSuficientes(empresa_id, mes, anio, supabase) {
  const rango = calcularRangoMes(anio, mes);

  const { count: total_tx, error: errTotal } = await supabase
    .from('transacciones_historicas')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .gte('fecha_transaccion', rango.fecha_inicio)
    .lte('fecha_transaccion', rango.fecha_fin);

  if (errTotal) {
    console.error('[evaluarDatosSuficientes] Error contando tx:', errTotal.message);
    return { suficientes: false, razon: 'error_query', totales: { total_tx: 0, categorizadas: 0, porcentaje_cat: 0 } };
  }

  if (total_tx === 0) {
    return { suficientes: false, razon: 'sin_movimientos', totales: { total_tx: 0, categorizadas: 0, porcentaje_cat: 0 } };
  }

  if (total_tx < 5) {
    return { suficientes: false, razon: 'pocas_transacciones', totales: { total_tx, categorizadas: 0, porcentaje_cat: 0 } };
  }

  const { count: categorizadas, error: errCat } = await supabase
    .from('transacciones_historicas')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .gte('fecha_transaccion', rango.fecha_inicio)
    .lte('fecha_transaccion', rango.fecha_fin)
    .not('categoria_id', 'is', null);

  if (errCat) {
    console.error('[evaluarDatosSuficientes] Error contando categorizadas:', errCat.message);
    return { suficientes: false, razon: 'error_query', totales: { total_tx, categorizadas: 0, porcentaje_cat: 0 } };
  }

  const porcentaje_cat = Math.round((categorizadas / total_tx) * 100);

  if (porcentaje_cat < 50) {
    return { suficientes: false, razon: 'pocas_categorizadas', totales: { total_tx, categorizadas, porcentaje_cat } };
  }

  return { suficientes: true, razon: 'ok', totales: { total_tx, categorizadas, porcentaje_cat } };
}

// ─── 2. leerCache ────────────────────────────────────────────────────────────

/**
 * Lee el cache de insights para un mes específico.
 *
 * @returns {Promise<object|null>} null si no hay cache
 */
async function leerCache(empresa_id, mes, anio, supabase) {
  const { data, error } = await supabase
    .from('insights_cache')
    .select('insights, recomendaciones, metricas, comparacion, tipo, created_at')
    .eq('empresa_id', empresa_id)
    .eq('mes', mes)
    .eq('anio', anio)
    .maybeSingle();

  if (error) {
    console.error('[leerCache] Error:', error.message);
    return null;
  }

  return data || null;
}

// ─── 3. guardarCache ─────────────────────────────────────────────────────────

/**
 * Guarda (upsert) insights en el cache.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function guardarCache({
  empresa_id, mes, anio, tipo,
  insights, recomendaciones, metricas, comparacion,
  modelo_usado, tokens_input, tokens_output, latencia_ms,
}, supabase) {
  const { error } = await supabase
    .from('insights_cache')
    .upsert({
      empresa_id,
      mes,
      anio,
      tipo,
      insights,
      recomendaciones,
      metricas,
      comparacion:   comparacion || null,
      modelo_usado:  modelo_usado || null,
      tokens_input:  tokens_input || null,
      tokens_output: tokens_output || null,
      latencia_ms:   latencia_ms || null,
      updated_at:    new Date().toISOString(),
    }, {
      onConflict: 'empresa_id,mes,anio',
    });

  if (error) {
    console.error('[guardarCache] Error:', error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

// ─── 4. borrarCache ──────────────────────────────────────────────────────────

/**
 * Borra el cache de un mes específico (para botón Regenerar). Idempotente.
 *
 * @returns {Promise<{ ok: boolean }>}
 */
async function borrarCache(empresa_id, mes, anio, supabase) {
  const { error } = await supabase
    .from('insights_cache')
    .delete()
    .eq('empresa_id', empresa_id)
    .eq('mes', mes)
    .eq('anio', anio);

  if (error) {
    console.error('[borrarCache] Error:', error.message);
    return { ok: false };
  }

  return { ok: true };
}

// ─── 5. construirContextoMes ─────────────────────────────────────────────────

/**
 * Construye el contexto financiero de un mes para pasarlo al prompt de IA.
 * Extrae el mes objetivo, el mes anterior y YoY del eerr_mensual de
 * obtenerContextoFinanciero. Si no están disponibles, hace query manual.
 *
 * @returns {Promise<{ mes_objetivo: object, mes_anterior: object|null, yoy: object|null }>}
 */
async function construirContextoMes(empresa_id, mes, anio, supabase) {
  // ── Cargar contexto financiero completo (reutiliza la misma función de Niko)
  let ctxFinanciero = null;
  try {
    ctxFinanciero = await obtenerContextoFinanciero(empresa_id);
  } catch (err) {
    console.error('[construirContextoMes] Error obteniendo contexto financiero:', err.message);
  }

  const NOMBRES_MES = [
    '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];

  const labelObjetivo = `${NOMBRES_MES[mes]} ${anio}`;

  // ── Extraer mes objetivo del eerr_mensual ────────────────────────────────
  const eerrMensual = ctxFinanciero?.eerr_mensual || [];
  let mesObj = eerrMensual.find(m => m.mes === mes && m.año === anio) || null;

  let origenObjetivo = 'eerr_mensual';
  if (!mesObj || mesObj.total_transacciones === 0) {
    // Fallback: query manual
    origenObjetivo = 'consultarPeriodo';
    mesObj = await _construirMesFallback(empresa_id, mes, anio, supabase);
  }

  const mes_objetivo = {
    label: labelObjetivo,
    mes,
    anio,
    origen: origenObjetivo,
    ..._extraerDatosMes(mesObj, origenObjetivo),
  };

  // ── Mes anterior ─────────────────────────────────────────────────────────
  const mesAntNum  = mes === 1 ? 12 : mes - 1;
  const anioAntNum = mes === 1 ? anio - 1 : anio;

  let mesAntObj = eerrMensual.find(m => m.mes === mesAntNum && m.año === anioAntNum) || null;
  let mes_anterior = null;

  if (mesAntObj && mesAntObj.total_transacciones > 0) {
    mes_anterior = {
      label: `${NOMBRES_MES[mesAntNum]} ${anioAntNum}`,
      mes: mesAntNum,
      anio: anioAntNum,
      ..._extraerDatosMes(mesAntObj, 'eerr_mensual'),
    };
  }

  // ── YoY (mismo mes, año anterior) ────────────────────────────────────────
  const anioYoY = anio - 1;
  let mesYoYObj = eerrMensual.find(m => m.mes === mes && m.año === anioYoY) || null;
  let yoy = null;

  if (mesYoYObj && mesYoYObj.total_transacciones > 0) {
    yoy = {
      label: `${NOMBRES_MES[mes]} ${anioYoY}`,
      mes,
      anio: anioYoY,
      ..._extraerDatosMes(mesYoYObj, 'eerr_mensual'),
    };
  }

  return { mes_objetivo, mes_anterior, yoy };
}

/**
 * Extrae campos estandarizados de un objeto de mes (eerr_mensual o fallback).
 * @private
 */
function _extraerDatosMes(mesObj, origen) {
  if (!mesObj) {
    return {
      total_transacciones: 0,
      subtotales: null,
      secciones: null,
      sin_categorizar: null,
    };
  }

  if (origen === 'eerr_mensual') {
    return {
      total_transacciones: mesObj.total_transacciones || 0,
      subtotales:          mesObj.subtotales || null,
      secciones:           mesObj.secciones || null,
      sin_categorizar:     mesObj.sin_categorizar || null,
    };
  }

  // Fallback: viene de _construirMesFallback (estructura simplificada)
  return {
    total_transacciones: mesObj.total_transacciones || 0,
    subtotales:          mesObj.subtotales || null,
    secciones:           null,
    sin_categorizar:     null,
  };
}

/**
 * Fallback: construye datos básicos de un mes via consultarPeriodo.
 * Se usa cuando el mes no está en eerr_mensual (ej. mes muy viejo).
 * @private
 */
async function _construirMesFallback(empresa_id, mes, anio, supabase) {
  const rango = calcularRangoMes(anio, mes);
  const transacciones = await consultarPeriodo(supabase, empresa_id, rango.fecha_inicio, rango.fecha_fin);

  if (!transacciones || transacciones.length === 0) {
    return { total_transacciones: 0, subtotales: null };
  }

  let entradas = 0, salidas = 0;
  for (const tx of transacciones) {
    const monto = Number(tx.monto_original) || 0;
    if (tx.tipo === 'ingreso') entradas += monto;
    else if (tx.tipo === 'egreso') salidas += monto;
  }

  const resultado_neto = entradas - salidas;
  const margen_caja = entradas > 0 ? ((resultado_neto / entradas) * 100) : 0;

  return {
    total_transacciones: transacciones.length,
    subtotales: {
      total_ingresos:  Math.round(entradas),
      costo_directo:   0,
      margen_bruto:    Math.round(entradas),
      margen_bruto_pct: 100,
      gastos_operacionales: 0,
      resultado_operacional: Math.round(resultado_neto),
      resultado_operacional_pct: parseFloat(margen_caja.toFixed(1)),
      gastos_financieros: 0,
      utilidad_neta: Math.round(resultado_neto),
      utilidad_neta_pct: parseFloat(margen_caja.toFixed(1)),
    },
  };
}

// ─── 6. generarInsightsIA ────────────────────────────────────────────────────

/**
 * Llama a Claude para generar insights + recomendaciones a partir del contexto.
 * NO escribe en BD — solo retorna el resultado para que el orquestador lo guarde.
 *
 * @param {object} params
 * @param {string} params.empresa_id
 * @param {number} params.mes
 * @param {number} params.anio
 * @param {object} params.contexto - resultado de construirContextoMes()
 * @returns {Promise<{ ok: boolean, insights?, recomendaciones?, metricas?, comparacion?, modelo_usado?, tokens_input?, tokens_output?, latencia_ms?, error? }>}
 */
async function generarInsightsIA({ empresa_id, mes, anio, contexto }) {
  const anthropic = new Anthropic();

  // ── Serializar contexto para el prompt ───────────────────────────────────
  const contextoTexto = _serializarContexto(contexto);
  const promptFinal = PROMPT_INSIGHTS_IA.replace('{{CONTEXTO_MES}}', contextoTexto);

  // ── Llamar a Claude ──────────────────────────────────────────────────────
  const inicio = Date.now();
  let response;

  try {
    response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1500,
      system:     promptFinal,
      messages:   [{ role: 'user', content: `Genera los insights y recomendaciones para ${contexto.mes_objetivo.label}.` }],
    });
  } catch (err) {
    const status = err?.status;
    if (status === 529 || status === 503 || status === 502 || status === 504) {
      console.error('[generarInsightsIA] Saturación API:', status);
      return { ok: false, error: 'api_saturada' };
    }
    console.error('[generarInsightsIA] Error API:', err.message);
    return { ok: false, error: 'api_fallo' };
  }

  const latencia_ms   = Date.now() - inicio;
  const tokens_input  = response.usage?.input_tokens || 0;
  const tokens_output = response.usage?.output_tokens || 0;

  // ── Extraer y parsear JSON ───────────────────────────────────────────────
  const textBlock = response.content.find(b => b.type === 'text');
  const textoRaw = textBlock?.text || '';

  let parsed;
  try {
    // Limpiar posibles code fences que Claude a veces agrega
    const limpio = textoRaw
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    parsed = JSON.parse(limpio);
  } catch {
    console.error('[generarInsightsIA] JSON inválido:', textoRaw.slice(0, 300));
    return { ok: false, error: 'json_invalido', latencia_ms, tokens_input, tokens_output };
  }

  // ── Validar estructura mínima ────────────────────────────────────────────
  if (!Array.isArray(parsed.insights) || !Array.isArray(parsed.recomendaciones)) {
    console.error('[generarInsightsIA] Estructura inválida: faltan arrays insights/recomendaciones');
    return { ok: false, error: 'estructura_invalida', latencia_ms, tokens_input, tokens_output };
  }

  // ── Construir métricas y comparación desde el contexto ───────────────────
  const sub = contexto.mes_objetivo.subtotales;
  const metricas = sub ? {
    entradas:       sub.total_ingresos,
    salidas:        (sub.costo_directo || 0) + (sub.gastos_operacionales || 0) + (sub.gastos_financieros || 0),
    resultado_neto: sub.utilidad_neta,
    margen_bruto_pct:          sub.margen_bruto_pct,
    resultado_operacional_pct: sub.resultado_operacional_pct,
    utilidad_neta_pct:         sub.utilidad_neta_pct,
  } : null;

  let comparacion = null;
  if (contexto.mes_anterior) {
    const subAnt = contexto.mes_anterior.subtotales;
    if (sub && subAnt) {
      comparacion = {
        mes_anterior: {
          label: contexto.mes_anterior.label,
          var_ingresos_pct:    variacionPct(sub.total_ingresos, subAnt.total_ingresos),
          var_utilidad_neta_pct: variacionPct(sub.utilidad_neta, subAnt.utilidad_neta),
        },
      };
    }
  }
  if (contexto.yoy) {
    const subYoY = contexto.yoy.subtotales;
    if (sub && subYoY) {
      comparacion = comparacion || {};
      comparacion.yoy = {
        label: contexto.yoy.label,
        var_ingresos_pct:    variacionPct(sub.total_ingresos, subYoY.total_ingresos),
        var_utilidad_neta_pct: variacionPct(sub.utilidad_neta, subYoY.utilidad_neta),
      };
    }
  }

  console.log('[generarInsightsIA] OK | tokens:', tokens_input + tokens_output, '| latencia:', latencia_ms, 'ms');

  return {
    ok: true,
    insights:       parsed.insights,
    recomendaciones: parsed.recomendaciones,
    metricas,
    comparacion,
    modelo_usado:   MODEL,
    tokens_input,
    tokens_output,
    latencia_ms,
  };
}

// ─── Helper: serializar contexto para el prompt ──────────────────────────────

function _serializarContexto(contexto) {
  const { mes_objetivo, mes_anterior, yoy } = contexto;
  const fmt = n => Math.round(n).toLocaleString('es-CL');

  const lines = [];

  // ── Mes objetivo ─────────────────────────────────────────────────────────
  lines.push(`== ${mes_objetivo.label} ==`);
  lines.push(`Transacciones: ${mes_objetivo.total_transacciones}`);

  const sub = mes_objetivo.subtotales;
  if (sub) {
    lines.push(`Ingresos totales: $${fmt(sub.total_ingresos)}`);
    lines.push(`Costo directo: $${fmt(sub.costo_directo)}`);
    lines.push(`Margen bruto: $${fmt(sub.margen_bruto)} (${sub.margen_bruto_pct}%)`);
    lines.push(`Gastos operacionales: $${fmt(sub.gastos_operacionales)}`);
    lines.push(`Resultado operacional: $${fmt(sub.resultado_operacional)} (${sub.resultado_operacional_pct}%)`);
    lines.push(`Gastos financieros: $${fmt(sub.gastos_financieros)}`);
    lines.push(`Utilidad neta: $${fmt(sub.utilidad_neta)} (${sub.utilidad_neta_pct}%)`);
  } else {
    lines.push('(Sin datos de EERR disponibles para este mes)');
  }

  // Top egresos por categoría
  if (mes_objetivo.secciones && Array.isArray(mes_objetivo.secciones)) {
    const egresoCats = mes_objetivo.secciones
      .filter(s => s.tipo === 'egreso')
      .flatMap(s => s.categorias || [])
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 5);

    if (egresoCats.length > 0) {
      lines.push('Top egresos por categoría:');
      egresoCats.forEach((c, i) => {
        lines.push(`  ${i + 1}. ${c.nombre}: $${fmt(c.monto)}`);
      });
    }
  }

  // Sin categorizar
  const sc = mes_objetivo.sin_categorizar;
  if (sc && (sc.ingreso > 0 || sc.egreso > 0)) {
    lines.push(`Sin categorizar: $${fmt(sc.ingreso)} en ingresos, $${fmt(sc.egreso)} en egresos`);
  }

  // ── Mes anterior ─────────────────────────────────────────────────────────
  if (mes_anterior) {
    lines.push('');
    lines.push(`== Mes anterior: ${mes_anterior.label} ==`);
    const subAnt = mes_anterior.subtotales;
    if (subAnt) {
      lines.push(`Ingresos: $${fmt(subAnt.total_ingresos)} | Utilidad neta: $${fmt(subAnt.utilidad_neta)} (${subAnt.utilidad_neta_pct}%)`);
      lines.push(`Margen bruto: ${subAnt.margen_bruto_pct}% | Resultado operacional: ${subAnt.resultado_operacional_pct}%`);
      // Variaciones
      if (sub) {
        const varIng = variacionPct(sub.total_ingresos, subAnt.total_ingresos);
        const varUtil = variacionPct(sub.utilidad_neta, subAnt.utilidad_neta);
        lines.push(`Variación MoM: ingresos ${varIng != null ? (varIng >= 0 ? '+' : '') + varIng + '%' : 'N/A'}, utilidad neta ${varUtil != null ? (varUtil >= 0 ? '+' : '') + varUtil + '%' : 'N/A'}`);
      }
    }
  } else {
    lines.push('');
    lines.push('== Mes anterior: sin datos disponibles ==');
  }

  // ── YoY ──────────────────────────────────────────────────────────────────
  if (yoy) {
    lines.push('');
    lines.push(`== Mismo mes año anterior: ${yoy.label} ==`);
    const subYoY = yoy.subtotales;
    if (subYoY) {
      lines.push(`Ingresos: $${fmt(subYoY.total_ingresos)} | Utilidad neta: $${fmt(subYoY.utilidad_neta)} (${subYoY.utilidad_neta_pct}%)`);
      if (sub) {
        const varIng = variacionPct(sub.total_ingresos, subYoY.total_ingresos);
        const varUtil = variacionPct(sub.utilidad_neta, subYoY.utilidad_neta);
        lines.push(`Variación YoY: ingresos ${varIng != null ? (varIng >= 0 ? '+' : '') + varIng + '%' : 'N/A'}, utilidad neta ${varUtil != null ? (varUtil >= 0 ? '+' : '') + varUtil + '%' : 'N/A'}`);
      }
    }
  } else {
    lines.push('');
    lines.push('== Mismo mes año anterior: sin datos disponibles ==');
  }

  return lines.join('\n');
}

// ─── 7. obtenerInsightsParaNiko ───────────────────────────────────────────────

/**
 * Obtiene insights y recomendaciones para un mes dado, optimizado para consumo
 * interno de Niko (sin guardar en cache, sin llamar IA).
 *
 * Lógica:
 *   - Mes actual  → determinístico fresco (nunca cachea)
 *   - Mes cerrado → lee cache; si MISS → determinístico fresco
 *
 * NUNCA llama generarInsightsIA ni guardarCache.
 *
 * @param {string} empresa_id
 * @param {number} mes  - 1-12
 * @param {number} anio - YYYY
 * @returns {Promise<{ insights: Array, recomendaciones: Array, fuente: string }>}
 *   fuente: 'cache' | 'deterministico_actual' | 'deterministico_fresh' | 'error'
 *   Nunca lanza excepción — en error devuelve arrays vacíos para no romper el
 *   contexto de Niko.
 */
async function obtenerInsightsParaNiko(empresa_id, mes, anio) {
  try {
    // ── Detectar mes actual (zona horaria Chile, idéntico a insights.js:229) ─
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    const esMesActual = (mes === ahora.getMonth() + 1 && anio === ahora.getFullYear());

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Mes cerrado: intentar cache ───────────────────────────────────────────
    if (!esMesActual) {
      const cached = await leerCache(empresa_id, mes, anio, supabase);
      if (cached) {
        return {
          insights:        cached.insights        || [],
          recomendaciones: cached.recomendaciones || [],
          fuente: 'cache',
        };
      }
    }

    // ── Calcular métricas del mes (mismo cálculo que insights.js:253-259) ────
    const rango    = calcularRangoMes(anio, mes);
    const txActual = await consultarPeriodo(supabase, empresa_id, rango.fecha_inicio, rango.fecha_fin);

    let entradas = 0, salidas = 0;
    for (const tx of txActual) {
      const monto = Number(tx.monto_original) || 0;
      if (tx.tipo === 'ingreso') entradas += monto;
      else if (tx.tipo === 'egreso') salidas += monto;
    }
    const resultado_neto = entradas - salidas;
    const margen_caja    = entradas > 0 ? (resultado_neto / entradas) * 100 : 0;
    const razon_salidas  = entradas > 0 ? (salidas / entradas) * 100 : 0;
    const metricas = { entradas, salidas, resultado_neto, margen_caja, razon_salidas };

    // ── Calcular comparación con mes anterior (mismo cálculo que insights.js:265-294)
    let comparacion = { disponible: false };
    try {
      const mesAnt  = mes === 1 ? 12 : mes - 1;
      const anioAnt = mes === 1 ? anio - 1 : anio;
      const rangoAnt = calcularRangoMes(anioAnt, mesAnt);
      const txAnt    = await consultarPeriodo(supabase, empresa_id, rangoAnt.fecha_inicio, rangoAnt.fecha_fin);

      let entradasAnt = 0, salidasAnt = 0;
      for (const tx of txAnt) {
        const monto = Number(tx.monto_original) || 0;
        if (tx.tipo === 'ingreso') entradasAnt += monto;
        else if (tx.tipo === 'egreso') salidasAnt += monto;
      }
      const resultadoAnt = entradasAnt - salidasAnt;

      if (entradasAnt > 0 || salidasAnt > 0) {
        comparacion = {
          disponible:        true,
          var_entradas_pct:  variacionPct(entradas,       entradasAnt),
          var_salidas_pct:   variacionPct(salidas,        salidasAnt),
          var_resultado_pct: variacionPct(resultado_neto, resultadoAnt),
        };
      }
    } catch (errAnt) {
      console.error('[obtenerInsightsParaNiko] Error período anterior:', errAnt.message);
    }

    // ── Generar determinístico ────────────────────────────────────────────────
    const det = generarDeterministico(metricas, comparacion);

    return {
      insights:        det.insights,
      recomendaciones: det.recomendaciones,
      fuente: esMesActual ? 'deterministico_actual' : 'deterministico_fresh',
    };
  } catch (err) {
    console.error('[obtenerInsightsParaNiko] Error:', err.message);
    return { insights: [], recomendaciones: [], fuente: 'error' };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  PROMPT_INSIGHTS_IA,
  evaluarDatosSuficientes,
  leerCache,
  guardarCache,
  borrarCache,
  construirContextoMes,
  generarInsightsIA,
  obtenerInsightsParaNiko,
};
