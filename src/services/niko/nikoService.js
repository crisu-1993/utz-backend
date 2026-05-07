'use strict';

const Anthropic                        = require('@anthropic-ai/sdk');
const { createClient }                 = require('@supabase/supabase-js');
const { buildSystemPrompt }            = require('./systemPrompt');
const { obtenerContextoFinanciero }    = require('./contextoFinanciero');

const MODEL = 'claude-sonnet-4-6';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

/**
 * Envía un mensaje a Niko y devuelve su respuesta.
 *
 * @param {string} empresa_id - UUID de la empresa activa (del authMiddleware)
 * @param {string} mensaje    - Texto enviado por el usuario
 * @param {string} user_id    - UUID del usuario autenticado (del authMiddleware)
 * @returns {{ respuesta: string, modelo_usado: string, tokens_usados: number }}
 */
async function chatWithNiko(empresa_id, mensaje, historial, user_id) {
  const supabase = getSupabase();

  // ── 1. Cargar datos de la empresa ─────────────────────────────────────────
  const { data, error } = await supabase
    .from('empresas')
    .select('nombre, giro, representante_nombre, representante_rol, tratamiento')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) {
    console.error(`[niko] Error query empresa ${empresa_id}:`, error.message);
    throw new Error('No se pudieron cargar los datos de la empresa');
  }

  if (!data) {
    console.error(`[niko] Empresa no encontrada: ${empresa_id}`);
    throw new Error('Empresa no encontrada');
  }

  // ── 2. Mapear datos con fallbacks seguros ─────────────────────────────────
  const nombreEmpresa  = data.nombre                 || 'tu empresa';
  const rubro          = data.giro                   || 'su rubro';
  const nombreCliente  = data.representante_nombre   || 'cliente';
  const rolCliente     = data.representante_rol      || 'dueño/a';
  const tratamiento    = data.tratamiento            || 'tu';

  // ── 3. Obtener contexto financiero ───────────────────────────────────────
  let contextoFinanciero = null;
  try {
    contextoFinanciero = await obtenerContextoFinanciero(empresa_id);
  } catch (errCtx) {
    console.error('[niko] Error cargando contexto financiero:', errCtx.message);
    // Continúa sin contexto financiero — Niko funciona igual, sin datos
  }

  // ── 4. Construir system prompt base ──────────────────────────────────────
  const systemPromptBase = buildSystemPrompt({
    nombreCliente,
    rolCliente,
    nombreEmpresa,
    rubro,
    tratamiento,
  });

  // ── 5. Formatear contexto financiero e inyectarlo al prompt ──────────────
  const tieneContexto = contextoFinanciero && (
    contextoFinanciero.resumenes_por_mes.length > 0 ||
    (contextoFinanciero.datos_manuales && contextoFinanciero.datos_manuales.length > 0)
  );
  const systemPromptFinal = tieneContexto
    ? systemPromptBase + '\n\n## CONTEXTO FINANCIERO ACTUAL\n\n' + formatearContexto(contextoFinanciero)
    : systemPromptBase;

  // ── 6. Llamar a Claude ────────────────────────────────────────────────────
  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 2000,
    system:     systemPromptFinal,
    messages:   [
      ...(historial || []),
      { role: 'user', content: mensaje },
    ],
  });

  const textBlock     = response.content.find(b => b.type === 'text');
  const respuesta     = textBlock?.text ?? '';
  const tokens_usados = response.usage.input_tokens + response.usage.output_tokens;

  if (!respuesta || respuesta.trim().length === 0) {
    console.warn('[nikoService] Respuesta vacía de Claude, usando fallback');
    return {
      respuesta:     'Disculpa, hubo un problema. ¿Puedes repetir tu pregunta?',
      modelo_usado:  MODEL,
      tokens_usados: response.usage
        ? response.usage.input_tokens + response.usage.output_tokens
        : 0,
    };
  }

  return {
    respuesta,
    modelo_usado:  response.model,
    tokens_usados,
  };
}

// ─── Formatear contexto financiero como texto para el system prompt ──────────

function formatearContexto(contexto) {
  const { meses_disponibles, ultimo_mes_con_datos, resumenes_por_mes, datos_manuales } = contexto;

  const fmt = n => Math.round(n).toLocaleString('es-CL');

  const bloquesMeses = resumenes_por_mes.map(m => {
    const topLines = m.top_egresos.length > 0
      ? m.top_egresos.map((e, i) => `    ${i + 1}. ${e.categoria}: $${fmt(e.total)}`).join('\n')
      : '    (sin egresos categorizados)';

    return `▸ ${m.label}:
  - Ingresos: $${fmt(m.ingresos)}
  - Egresos: $${fmt(m.egresos)}
  - Resultado: $${fmt(m.resultado)}
  - Margen: ${m.margen_pct}%
  - Transacciones: ${m.total_transacciones}
  - Top egresos:
${topLines}`;
  });

  // ── Sección datos históricos manuales ─────────────────────────────────────
  let bloqueManual = '';
  if (datos_manuales && datos_manuales.length > 0) {
    const lineas = datos_manuales.map(d => `▸ ${d.periodo}:
  - Ingresos: $${fmt(d.ingresos)}
  - Egresos: $${fmt(d.egresos)}
  - Resultado: $${fmt(d.resultado)}`);
    bloqueManual = `\n\n═════ DATOS HISTÓRICOS Y MANUALES ═════\n\n${lineas.join('\n\n')}`;
  }

  const encabezado = meses_disponibles.length > 0
    ? `Meses con datos: ${meses_disponibles.join(', ')}\nÚltimo mes con datos: ${ultimo_mes_con_datos.label}\n\n═════ RESUMEN POR MES ═════\n\n${bloquesMeses.join('\n\n')}`
    : '(Sin datos bancarios disponibles)';

  return `DATOS FINANCIEROS DISPONIBLES\n\n${encabezado}${bloqueManual}`;
}

module.exports = { chatWithNiko };
