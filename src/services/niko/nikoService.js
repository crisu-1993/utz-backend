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
async function chatWithNiko(empresa_id, mensaje, user_id) {
  const supabase = getSupabase();

  // ── 1. Cargar datos de la empresa ─────────────────────────────────────────
  const { data, error } = await supabase
    .from('empresas')
    .select('nombre, giro, representante_nombre, representante_rol, tratamiento')
    .eq('id', empresa_id)
    .single();

  if (error) {
    console.error(`[niko] Error cargando empresa ${empresa_id}:`, error.message);
    throw new Error('No se pudieron cargar los datos de la empresa');
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
  const systemPromptFinal = contextoFinanciero && contextoFinanciero.resumenes_por_mes.length > 0
    ? systemPromptBase + '\n\n## CONTEXTO FINANCIERO ACTUAL\n\n' + formatearContexto(contextoFinanciero)
    : systemPromptBase;

  // ── 6. Llamar a Claude ────────────────────────────────────────────────────
  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 1500,
    system:     systemPromptFinal,
    messages:   [{ role: 'user', content: mensaje }],
  });

  const respuesta     = response.content[0].text;
  const tokens_usados = response.usage.input_tokens + response.usage.output_tokens;

  return {
    respuesta,
    modelo_usado:  response.model,
    tokens_usados,
  };
}

// ─── Formatear contexto financiero como texto para el system prompt ──────────

function formatearContexto(contexto) {
  const { meses_disponibles, ultimo_mes_con_datos, resumenes_por_mes } = contexto;

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

  return `DATOS FINANCIEROS DISPONIBLES

Meses con datos: ${meses_disponibles.join(', ')}
Último mes con datos: ${ultimo_mes_con_datos.label}

═════ RESUMEN POR MES ═════

${bloquesMeses.join('\n\n')}`;
}

module.exports = { chatWithNiko };
