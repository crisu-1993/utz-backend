'use strict';

const Anthropic                        = require('@anthropic-ai/sdk');
const { createClient }                 = require('@supabase/supabase-js');
const { buildSystemPrompt }            = require('./systemPrompt');
const { obtenerContextoFinanciero }    = require('./contextoFinanciero');

const MODEL = 'claude-sonnet-4-6';

// ─── Tool spec para Claude API ────────────────────────────────────────────────
//
// Niko dispone de esta tool para guardar reglas de categorización cuando el
// usuario confirma explícitamente cómo clasificar un patrón de transacciones.

const NIKO_TOOLS = [
  {
    name: 'guardar_regla_categorizacion',
    description: "Guarda una regla permanente que asocia un patrón de texto con una categoría del EERR. Llama esta tool ÚNICAMENTE cuando el usuario confirmó de forma explícita y clara (ejemplos de confirmación válida: 'sí', 'dale', 'listo', 'hagámoslo', 'perfecto', 'ya', 'ok', 'bueno', 'sí po'). NUNCA la llames si el usuario dudó, preguntó algo más, cambió de tema, o no respondió con claridad afirmativa. Si hay duda, primero aclara y espera confirmación.",
    input_schema: {
      type: 'object',
      properties: {
        patron: {
          type: 'string',
          description: "Texto del patrón en minúsculas, exactamente como aparece en descripcion_normalizada de las transacciones. Ejemplos: 'redcompra', '18720058-k', 'don manuel', 'copec'. NO incluyas espacios extra ni caracteres extraños.",
        },
        categoria_nombre: {
          type: 'string',
          enum: [
            'Ventas',
            'Otros ingresos',
            'Costo Directo',
            'Sueldos y honorarios',
            'Servicios básicos',
            'Arriendo',
            'Marketing',
            'Operacional',
            'Impuestos',
            'Inversión',
            'Financieros',
            'Otros',
          ],
          description: 'Nombre exacto de la categoría del catálogo de la empresa. Debe ser uno de los valores del enum. Si el usuario propone un nombre que no existe en el catálogo, mapéalo al más cercano y confírmalo antes de llamar la tool.',
        },
        tipo_patron: {
          type: 'string',
          enum: ['contiene', 'empieza_con', 'exacto'],
          description: "Tipo de coincidencia al buscar el patrón. 'contiene' (recomendado): aparece en cualquier parte. 'empieza_con': prefijo. 'exacto': descripción idéntica. Si no estás seguro, usa 'contiene'.",
        },
        descripcion_aprendida: {
          type: 'string',
          description: "Contexto que el usuario te dio al confirmar la regla, en sus propias palabras. Ej: 'le compro harina a Don Manuel', 'es el arriendo del local'. Esto te ayuda a recordar de qué se trata el patrón. Si el usuario no dio contexto explícito, déjalo vacío.",
        },
      },
      required: ['patron', 'categoria_nombre', 'tipo_patron'],
    },
  },
];

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── ejecutarTool ─────────────────────────────────────────────────────────────
//
// Ejecuta una tool que Niko pidió usar.
// Por ahora MOCK: solo loguea y devuelve éxito simulado.
// La conexión real al endpoint de crear regla se implementa en 2B.7.
//
// @param {object} toolUseBlock - bloque type:'tool_use' de la respuesta de Claude
// @param {string} empresa_id   - empresa que ejecuta la tool
// @param {string} user_id      - usuario que ejecuta la tool
// @returns {object} { ok, mensaje, datos? }

async function ejecutarTool(toolUseBlock, empresa_id, user_id) {
  const { name, input, id: tool_use_id } = toolUseBlock;

  console.log('[ejecutarTool] Niko pidió usar tool:', {
    tool_use_id,
    name,
    empresa_id,
    user_id,
    input,
  });

  if (name === 'guardar_regla_categorizacion') {
    // Require lazy para evitar potenciales circular imports al arrancar
    const { crearRegla } = require('../../routes/categorias');

    const supabase = getSupabase();

    const resultado = await crearRegla(supabase, {
      empresa_id,
      patron:                input.patron,
      categoria_nombre:      input.categoria_nombre,
      tipo_patron:           input.tipo_patron || 'contiene',
      descripcion_aprendida: input.descripcion_aprendida || null,
      creada_por:            'niko',   // hardcodeado — nunca del input de Claude
    });

    if (resultado.ok) {
      return {
        ok:     true,
        mensaje: resultado.mensaje,
        datos: {
          regla_id:                resultado.regla_id,
          accion:                  resultado.accion,
          transacciones_afectadas: resultado.transacciones_afectadas,
          warning:                 resultado.warning,
        },
      };
    } else {
      return {
        ok:      false,
        mensaje: `Error al guardar regla: ${resultado.error}`,
        codigo:  resultado.codigo,
      };
    }
  }

  console.error('[ejecutarTool] Tool desconocida:', name);
  return {
    ok:      false,
    mensaje: `Tool '${name}' no implementada`,
  };
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
    contextoFinanciero.resumenes_por_mes?.length > 0        ||
    contextoFinanciero.datos_manuales?.length > 0           ||
    contextoFinanciero.patrones_pendientes?.length > 0      ||
    contextoFinanciero.reglas_activas?.length > 0
  );
  const systemPromptFinal = tieneContexto
    ? systemPromptBase + '\n\n## CONTEXTO FINANCIERO ACTUAL\n\n' + formatearContexto(contextoFinanciero)
    : systemPromptBase;

  // ── 6. Llamar a Claude (primera ronda, con tools) ────────────────────────
  const anthropic = new Anthropic();

  let response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 2000,
    system:     systemPromptFinal,
    tools:      NIKO_TOOLS,
    messages:   [
      ...(historial || []),
      { role: 'user', content: mensaje },
    ],
  });

  let totalInputTokens  = response.usage?.input_tokens  || 0;
  let totalOutputTokens = response.usage?.output_tokens || 0;

  // ── 7. Tool calling: segunda ronda si Claude pidió usar una tool ──────────
  if (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find(b => b.type === 'tool_use');

    if (toolUseBlock) {
      console.log('[chatWithNiko] Claude pidió tool:', toolUseBlock.name);

      const toolResult = await ejecutarTool(toolUseBlock, empresa_id, user_id);

      // Segunda ronda SIN tools para evitar loops
      response = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: 2000,
        system:     systemPromptFinal,
        messages:   [
          ...(historial || []),
          { role: 'user',      content: mensaje },
          { role: 'assistant', content: response.content },
          {
            role:    'user',
            content: [
              {
                type:        'tool_result',
                tool_use_id: toolUseBlock.id,
                content:     toolResult.ok
                  ? toolResult.mensaje
                  : `Error: ${toolResult.mensaje}`,
              },
            ],
          },
        ],
      });

      totalInputTokens  += response.usage?.input_tokens  || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const respuesta = textBlock?.text ?? '';

  if (!respuesta || respuesta.trim().length === 0) {
    console.warn('[nikoService] Respuesta vacía de Claude, usando fallback');
    return {
      respuesta:     'Disculpa, hubo un problema. ¿Puedes repetir tu pregunta?',
      modelo_usado:  MODEL,
      tokens_usados: totalInputTokens + totalOutputTokens,
    };
  }

  const tokens_usados = totalInputTokens + totalOutputTokens;

  return {
    respuesta,
    modelo_usado:  response.model,
    tokens_usados,
  };
}

// ─── Formatear contexto financiero como texto para el system prompt ──────────

function formatearContexto(contexto) {
  const {
    meses_disponibles,
    ultimo_mes_con_datos,
    resumenes_por_mes,
    datos_manuales,
    patrones_pendientes,
    reglas_activas,
  } = contexto;

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

  // ── Bloque A: Patrones pendientes (score >= 70) ───────────────────────────
  let bloquePatrones = '';
  const patronesFiltrados = (patrones_pendientes || []).filter(p => p.score >= 70);

  if (patronesFiltrados.length > 0) {
    const lineasPatrones = patronesFiltrados.map((p, i) => {
      const tipo = p.es_mixto
        ? 'FLUJO MIXTO (entrada y salida) — preguntar diferente'
        : p.tipo_predominante === 'ingreso'
          ? 'ingresos'
          : 'egresos';

      const ejemplos = (p.ejemplos_descripcion || []).slice(0, 2).join(', ');

      return `${i + 1}. "${p.patron}" — score ${p.score}
   - ${p.veces_aparece} transacciones | $${fmt(p.monto_total)} acumulado
   - Tipo: ${tipo}
   - Ejemplos: ${ejemplos}`;
    });

    bloquePatrones = `\n\n═════ PATRONES PENDIENTES DE CATEGORIZAR ═════\n\n` +
      `Hay ${patronesFiltrados.length} patrones con alta confianza (score 70+) sin categoría asignada.\n` +
      `Están ordenados por relevancia (score 0-100).\n\n` +
      `⚠️  Usa esta información para preguntar al cliente de forma natural cuando sea el momento. ` +
      `No preguntes por todos en un mismo mensaje. Máximo 1-2 patrones por turno.\n\n` +
      lineasPatrones.join('\n\n');
  }

  // ── Bloque B: Reglas ya aprendidas (siempre visible) ─────────────────────
  let bloqueReglas = '\n\n═════ REGLAS YA APRENDIDAS ═════\n\n';

  if ((reglas_activas || []).length > 0) {
    const lineasReglas = reglas_activas.map(r => {
      const contextoAprendido = r.descripcion_aprendida
        ? ` — "${r.descripcion_aprendida}"`
        : '';
      return `- "${r.patron}" → ${r.categoria_nombre} (${r.tipo_patron})${contextoAprendido}`;
    });
    bloqueReglas += lineasReglas.join('\n');
  } else {
    bloqueReglas += '(sin reglas guardadas todavía)';
  }

  const encabezado = meses_disponibles.length > 0
    ? `Meses con datos: ${meses_disponibles.join(', ')}\nÚltimo mes con datos: ${ultimo_mes_con_datos.label}\n\n═════ RESUMEN POR MES ═════\n\n${bloquesMeses.join('\n\n')}`
    : '(Sin datos bancarios disponibles)';

  return `DATOS FINANCIEROS DISPONIBLES\n\n${encabezado}${bloqueManual}${bloquePatrones}${bloqueReglas}`;
}

module.exports = { chatWithNiko };
