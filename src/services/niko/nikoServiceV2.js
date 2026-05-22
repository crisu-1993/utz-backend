'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// nikoServiceV2.js — Niko Multi-Agente
// ═══════════════════════════════════════════════════════════════════════════════
//
// Arquitectura: router → agentes especializados → validador → retry
//
// ESTADO DE CONSTRUCCIÓN:
//   Bloque 0 (ACTUAL) — Infraestructura base agnóstica:
//     markers, NIKO_TOOLS, ejecutarTool, saturación, getSupabase.
//   Bloque 1 — supervisor.js unificado (validador + phantom)
//   Bloque 2 — llamarAgente() wrapper
//   Bloque 3 — agenteListar
//   Bloque 4 — agenteCrear
//   Bloque 5 — agenteConv + contexto financiero
//   Bloque 6 — flujoModificar (contexto + modificar + retry)
//   Bloque 7 — router (routingShortcut + llamarMadreJSON)
//   Bloque 8 — chatWithNikoStreamV2() integración total
//
// REGLA DE ORO: el monolito (nikoService.js) NO se toca hasta el switch final.
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic        = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const markers          = require('./agents/markers');
const supervisor       = require('./supervisor');
const agenteListar                  = require('./agents/listar');
const agenteCrear                   = require('./agents/crear');
const agenteConv                    = require('./agents/conversacion');
const agenteCtx                     = require('./agents/contexto');
const agenteMod                     = require('./agents/modificar');
const agenteMadre                   = require('./agents/madre');
const { obtenerContextoFinanciero } = require('./contextoFinanciero');

const MODEL = 'claude-sonnet-4-6';

// ─── Mensajes de Niko ante saturación ────────────────────────────────────────
// Se usan cuando Anthropic devuelve 529, 503, 502 o 504 (errores
// transitorios). Niko responde "como si estuviera ocupado" en lugar
// de mostrar error técnico al usuario.

const PLANTILLAS_SATURACION = [
  'Disculpa jefe, justo tuve una emergencia en la casa. ¿Hablamos en un rato?',
  'Se me cayó el internet, jefe. Estoy intentando reconectarme. Vuelve a escribirme en unos minutos.',
  'Jefe, justo salí un momento, no me puedo conectar bien ahora. Dame unos minutos y retomamos.',
  'Estoy con un tema personal complicado en este momento, jefe. ¿Podemos retomar en un rato?',
  'Estoy en un taco horrible, jefe, pero voy en camino. Dame unos minutos y nos conectamos.',
  'Tuve que salir a hacer un trámite urgente, jefe. ¿Podemos retomar en un rato?',
];

const STATUS_SATURACION = new Set([529, 503, 502, 504]);

function esErrorSaturacion(err) {
  return err && typeof err.status === 'number' && STATUS_SATURACION.has(err.status);
}

function mensajeSaturacionAleatorio() {
  const i = Math.floor(Math.random() * PLANTILLAS_SATURACION.length);
  return PLANTILLAS_SATURACION[i];
}

// ─── Tool spec para Claude API ────────────────────────────────────────────────
//
// Niko dispone de estas tools. Cada agente especialista recibe solo el
// subconjunto definido en su TOOLS_PERMITIDAS — el array NIKO_TOOLS completo
// se filtra en llamarAgente() (Bloque 2).

const NIKO_TOOLS = [
  {
    name: 'guardar_regla_categorizacion',
    description: "PROHIBIDO: decir 'voy a guardar la regla', 'déjame procesar', 'otro sistema lo hará'. Tú eres Niko y tú guardas la regla.\n\nGuarda una regla permanente que asocia un patrón de texto con una categoría del EERR. Llama esta tool ÚNICAMENTE cuando el usuario confirmó de forma explícita y clara (ejemplos de confirmación válida: 'sí', 'dale', 'listo', 'hagámoslo', 'perfecto', 'ya', 'ok', 'bueno', 'sí po'). NUNCA la llames si el usuario dudó, preguntó algo más, cambió de tema, o no respondió con claridad afirmativa. Si hay duda, primero aclara y espera confirmación. IMPORTANTE: Antes de llamar esta tool, valida con el usuario que la categoría elegida sea coherente con el tipo de las transacciones (Ventas/Otros ingresos solo para ingresos; el resto solo para egresos). Si el bloque es mixto (hay tanto ingresos como egresos con ese patrón), pregúntale al usuario antes de aplicar. Si después de aplicar la regla recibes incoherencias_detectadas en el resultado, informa al usuario y pregunta cómo categorizar las transacciones pendientes.",
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
  {
    name: 'crear_recordatorio',
    description: `Crea un recordatorio en la pestaña 'Creados por mí' del usuario.

CUÁNDO LLAMARLA: cuando el usuario te pide explícitamente agendar algo Y ya recibiste su confirmación EXPLÍCITA de la fecha en un turno PREVIO ('sí', 'dale', 'confirma', 'ok'). El primer mensaje del usuario donde menciona el recordatorio NO es confirmación — es intención. Siempre hay 2 turnos: turno 1 propones fecha y preguntas, turno 2 (tras confirmación) llamas esta tool.

CÓMO LLAMARLA: en silencio. Tú la ejecutas directamente con la fecha en formato YYYY-MM-DD. Nunca digas 'voy a agendar', 'déjame guardar', 'consultando el sistema' — solo ejecuta y después confirma al usuario con 'Listo, agendado para DD/MM/AAAA'.

PROHIBIDO: decir que otro sistema, módulo o asistente lo hace. Tú eres Niko y tú lo agendas. NO simules haber llamado esta tool — si no la llamaste, no digas 'listo, agendado'.`,
    input_schema: {
      type: 'object',
      properties: {
        titulo: {
          type: 'string',
          description: 'Título corto del recordatorio.',
        },
        descripcion: {
          type: 'string',
          description: 'Descripción opcional del recordatorio.',
        },
        fecha_vencimiento: {
          type: 'string',
          description: 'Fecha en formato YYYY-MM-DD.',
        },
        hora_vencimiento: {
          type: 'string',
          description: 'Hora en formato HH:MM (24h). Default 09:00 si no se especifica.',
        },
      },
      required: ['titulo', 'fecha_vencimiento'],
    },
  },
  {
    name: 'listar_recordatorios',
    description: `Lista los recordatorios del usuario.

CUÁNDO LLAMARLA: cuando el usuario pregunta '¿qué tengo agendado?', '¿qué tengo pendiente?', o cuando necesitas identificar UN recordatorio para editar/completar/eliminar/reactivar.

OPTIMIZACIÓN CRÍTICA: si en tus mensajes anteriores del MISMO historial ya escribiste un comentario invisible <!-- NIKO_ID:[uuid] -->, significa que YA identificaste el recordatorio. NO vuelvas a llamar listar_recordatorios. Solo extrae el UUID del comentario invisible y úsalo directo con actualizar_recordatorio o eliminar_recordatorio.

CÓMO LLAMARLA: en silencio. Nunca digas 'déjame buscar', 'consultando mis registros', 'voy a verificar' — solo ejecuta y presenta el resultado al usuario en lenguaje natural.

PROHIBIDO: decir que otro sistema busca por ti. Tú eres Niko y tú buscas.`,
    input_schema: {
      type: 'object',
      properties: {
        titulo_busqueda: {
          type: 'string',
          description: 'Palabra clave para buscar en el título (opcional). Útil cuando el usuario menciona un recordatorio por nombre parcial.',
        },
        completado: {
          type: 'boolean',
          description: 'Si true, lista solo completados. Si false, solo pendientes. Si se omite, lista todos.',
        },
        scope: {
          type: 'string',
          enum: ['activos', 'proximos'],
          description: 'Filtro temporal para pendientes. "activos": recordatorios cuya fecha+hora YA pasó (la alerta ya sonó, falta marcarlos). "proximos": recordatorios cuya fecha+hora aún NO llega (futuros). Solo aplica con completado:false u omitido. Para completados usa completado:true. Para buscar uno por nombre usa titulo_busqueda.',
        },
      },
      required: [],
    },
  },
  {
    name: 'actualizar_recordatorio',
    description: `Actualiza un recordatorio existente. Cubre editar (título, descripción, fecha, hora) Y completar/descompletar.

CUÁNDO LLAMARLA: cuando el usuario confirmó explícitamente que quiere modificar/completar/reactivar un recordatorio ya identificado. SIEMPRE hay 2 turnos: turno 1 identificas + propones + esperas 'sí', turno 2 (tras confirmación) llamas esta tool.

CÓMO OBTENER EL UUID: en tu mensaje del turno anterior debiste escribir un comentario invisible <!-- NIKO_ID:[uuid] -->. En este turno, lee ese comentario y extrae el UUID directamente. NUNCA inventes el UUID. NUNCA vuelvas a llamar listar_recordatorios si ya tienes el comentario.

CÓMO LLAMARLA: en silencio. Después confirma al usuario con 'Listo, marqué [título] como hecho' o 'Listo, cambié la fecha a DD/MM/AAAA'.

PROHIBIDO: decir 'voy a actualizar', 'déjame modificar', 'otro sistema lo hará'. Tú eres Niko y tú lo actualizas. NO simules — si no llamaste la tool, no digas 'listo'.`,
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID del recordatorio (obtenido de listar_recordatorios). NUNCA inventes este valor.',
        },
        titulo: {
          type: 'string',
          description: 'Nuevo título (opcional).',
        },
        descripcion: {
          type: 'string',
          description: 'Nueva descripción (opcional).',
        },
        fecha_vencimiento: {
          type: 'string',
          description: 'Nueva fecha YYYY-MM-DD (opcional).',
        },
        hora_vencimiento: {
          type: 'string',
          description: 'Nueva hora HH:MM (opcional). Si pasas "" o null, se resetea a 09:00 por defecto. La hora siempre es obligatoria en BD, no se puede "quitar".',
        },
        completado: {
          type: 'boolean',
          description: 'true para marcar completado, false para descompletar.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'eliminar_recordatorio',
    description: `Elimina un recordatorio definitivamente. Acción IRREVERSIBLE.

CUÁNDO LLAMARLA: cuando el usuario confirmó explícitamente que quiere eliminar un recordatorio ya identificado. SIEMPRE hay 2 turnos: turno 1 identificas + preguntas '¿confirmas que lo elimino?', turno 2 (tras confirmación) llamas esta tool.

CÓMO OBTENER EL UUID: en tu mensaje del turno anterior debiste escribir un comentario invisible <!-- NIKO_ID:[uuid] -->. En este turno, lee ese comentario y extrae el UUID directamente. NUNCA inventes el UUID. NUNCA vuelvas a llamar listar_recordatorios si ya tienes el comentario.

CÓMO LLAMARLA: en silencio. Después confirma con 'Listo, eliminé [título]'.

PROHIBIDO: decir 'voy a eliminar', 'déjame borrar', 'otro sistema lo hará'. Tú eres Niko y tú lo eliminas. NO simules — si no llamaste la tool, no digas 'eliminado'.`,
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID del recordatorio (obtenido de listar_recordatorios). NUNCA inventes este valor.',
        },
      },
      required: ['id'],
    },
  },
];

// ─── Supabase client ──────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── ejecutarTool ─────────────────────────────────────────────────────────────
//
// Ejecuta en Supabase la tool que el agente pidió usar.
// Cubre las 5 tools del catálogo: guardar_regla_categorizacion,
// crear_recordatorio, listar_recordatorios, actualizar_recordatorio,
// eliminar_recordatorio.
//
// @param {object} toolUseBlock - bloque type:'tool_use' de la respuesta de Claude
// @param {string} empresa_id   - empresa que ejecuta la tool
// @param {string} user_id      - usuario que ejecuta la tool
// @returns {object} { ok, mensaje, datos?, choques? }

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
          incoherencias_detectadas: resultado.incoherencias_detectadas ?? null,
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

  if (name === 'crear_recordatorio') {
    const { crearRecordatorio } = require('../../routes/recordatorios');
    const supabase  = getSupabase();
    const horaFinal = input.hora_vencimiento || '09:00';
    const horaSQL   = horaFinal.length === 5 ? `${horaFinal}:00` : horaFinal;

    console.log('[ejecutarTool] Creando recordatorio:', {
      tool_use_id,
      empresa_id,
      user_id,
      titulo:            input.titulo,
      fecha_vencimiento: input.fecha_vencimiento,
      hora_vencimiento:  horaFinal,
    });

    // Verificar choques (informativo, no bloqueante)
    let choquesAviso = null;
    const { data: choquesData, error: choquesError } = await supabase.rpc('verificar_choque_recordatorio', {
      p_empresa_id: empresa_id,
      p_fecha:      input.fecha_vencimiento,
      p_hora:       horaSQL,
    });

    if (choquesError) {
      console.error('[ejecutarTool] Error verificar_choque interno:', choquesError.message);
      // Fallback: continuar sin avisos
    } else if (choquesData && choquesData.length > 0) {
      choquesAviso = choquesData.map(r => ({
        id:                r.id,
        titulo:            r.titulo,
        fecha_vencimiento: r.fecha_vencimiento,
        hora_vencimiento:  r.hora_vencimiento,
        tipo_choque:       r.tipo_choque,  // 'exacto' o 'cercano' (informativo)
      }));
    }

    // CREAR siempre
    const resultado = await crearRecordatorio({
      empresa_id,
      user_id,
      titulo:            input.titulo,
      descripcion:       input.descripcion || null,
      fecha_vencimiento: input.fecha_vencimiento,
      hora_vencimiento:  horaFinal,
      origen:            'niko_a_pedido',
    });

    if (!resultado.ok) {
      return { ok: false, mensaje: resultado.mensaje || 'No pude crear el recordatorio.' };
    }

    return {
      ok:      true,
      mensaje: 'Recordatorio creado.',
      datos: {
        recordatorio_id:   resultado.recordatorio.id,
        titulo:            resultado.recordatorio.titulo,
        fecha_vencimiento: resultado.recordatorio.fecha_vencimiento,
        hora_vencimiento:  horaFinal,
      },
      choques: choquesAviso,
    };
  }

  if (name === 'listar_recordatorios') {
    const { listarRecordatorios } = require('../../routes/recordatorios');

    const resultado = await listarRecordatorios({
      empresa_id,
      scope:           input.scope,
      titulo_busqueda: input.titulo_busqueda,
      completado:      input.completado,
    });

    if (!resultado.ok) {
      return { ok: false, mensaje: resultado.mensaje || 'No pude listar los recordatorios' };
    }

    const lista = resultado.recordatorios.map(r => ({
      id:                r.id,
      titulo:            r.titulo,
      descripcion:       r.descripcion,
      fecha_vencimiento: r.fecha_vencimiento,
      hora_vencimiento:  r.hora_vencimiento,
      completado:        r.completado,
    }));

    return {
      ok:      true,
      mensaje: `Encontré ${lista.length} recordatorio${lista.length !== 1 ? 's' : ''}.`,
      datos:   lista,
    };
  }

  if (name === 'actualizar_recordatorio') {
    const { actualizarRecordatorio } = require('../../routes/recordatorios');
    const supabase = getSupabase();

    // Verificar choques SOLO si se está modificando fecha y/o hora
    let choquesAviso = null;
    if (input.fecha_vencimiento || input.hora_vencimiento) {
      // Obtener el recordatorio actual para conocer la fecha/hora existentes
      const { data: actual } = await supabase
        .from('recordatorios')
        .select('fecha_vencimiento, hora_vencimiento')
        .eq('id', input.id)
        .single();

      const fechaFinal = input.fecha_vencimiento || actual?.fecha_vencimiento;
      const horaFinal  = input.hora_vencimiento  || actual?.hora_vencimiento;

      if (fechaFinal && horaFinal) {
        const horaSQL = horaFinal.length === 5 ? `${horaFinal}:00` : horaFinal;

        const { data: choquesData, error: choquesError } = await supabase.rpc('verificar_choque_recordatorio', {
          p_empresa_id: empresa_id,
          p_fecha:      fechaFinal,
          p_hora:       horaSQL,
        });

        if (choquesError) {
          console.error('[ejecutarTool] Error verificar_choque interno (actualizar):', choquesError.message);
        } else if (choquesData && choquesData.length > 0) {
          // Excluir el propio recordatorio que estamos actualizando (evita falso positivo)
          const choquesFiltrados = choquesData.filter(r => r.id !== input.id);
          if (choquesFiltrados.length > 0) {
            choquesAviso = choquesFiltrados.map(r => ({
              id:                r.id,
              titulo:            r.titulo,
              fecha_vencimiento: r.fecha_vencimiento,
              hora_vencimiento:  r.hora_vencimiento,
              tipo_choque:       r.tipo_choque,
            }));
          }
        }
      }
    }

    const resultado = await actualizarRecordatorio({
      empresa_id,
      id:                input.id,
      titulo:            input.titulo,
      descripcion:       input.descripcion,
      fecha_vencimiento: input.fecha_vencimiento,
      hora_vencimiento:  input.hora_vencimiento,
      completado:        input.completado,
    });

    if (!resultado.ok) {
      return { ok: false, mensaje: resultado.mensaje || 'No pude actualizar el recordatorio' };
    }

    return {
      ok:      true,
      mensaje: 'Recordatorio actualizado correctamente.',
      datos:   resultado.recordatorio,
      choques: choquesAviso,
    };
  }

  if (name === 'eliminar_recordatorio') {
    const { eliminarRecordatorio } = require('../../routes/recordatorios');

    const resultado = await eliminarRecordatorio({
      empresa_id,
      id: input.id,
    });

    if (!resultado.ok) {
      return { ok: false, mensaje: resultado.mensaje || 'No pude eliminar el recordatorio' };
    }

    return { ok: true, mensaje: 'Recordatorio eliminado.' };
  }

  console.error('[ejecutarTool] Tool desconocida:', name);
  return {
    ok:      false,
    mensaje: `Tool '${name}' no implementada`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 2 — llamarAgente()
// ═══════════════════════════════════════════════════════════════════════════════
//
// Función genérica que ejecuta CUALQUIER agente multi-agente.
// Maneja R1 (buffered) + R2 (streamed si hay tool call).
// Aplica verificarDobleRespuesta y verificarVerbalizacion del supervisor.
//
// @param {object} agenteModule  - Módulo importado del agente (tiene TOOLS_PERMITIDAS)
// @param {object} input         - { system, messages } ya construido con construirInput()
// @param {Function} emit        - función SSE
// @param {string} empresa_id    - para ejecutarTool
// @param {string} user_id       - para ejecutarTool
// @param {string|null} toolChoice - 'auto' | 'any' | null (null = sin tool_choice override)
// @returns {{ texto, toolsUsadas, usage, stopReasonR1, saturado, toolResult? }}

async function llamarAgente({ agenteModule, input, emit, empresa_id, user_id, toolChoice = null }) {
  const anthropic = new Anthropic();

  // Filtrar tools a las que el agente tiene permitidas
  const toolsDelAgente = NIKO_TOOLS.filter(t =>
    agenteModule.TOOLS_PERMITIDAS.includes(t.name)
  );

  // ── RONDA 1 — stream buffered ─────────────────────────────────────────────
  let textoR1 = '';
  let stream1;

  try {
    const r1Opts = {
      model:      MODEL,
      max_tokens: 2000,
      system:     [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
      messages:   input.messages,
    };

    if (toolsDelAgente.length > 0) {
      r1Opts.tools = toolsDelAgente;
      if (toolChoice) r1Opts.tool_choice = { type: toolChoice };
    }

    stream1 = anthropic.messages.stream(r1Opts);

    for await (const event of stream1) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        textoR1 += event.delta.text;
      }
    }
  } catch (err) {
    if (esErrorSaturacion(err)) {
      const msg = mensajeSaturacionAleatorio();
      emit('delta', { texto: msg });
      return { texto: msg, toolsUsadas: [], usage: { input_tokens: 0, output_tokens: 0 }, stopReasonR1: 'saturacion', saturado: true };
    }
    throw err;
  }

  const finalMsg1 = await stream1.finalMessage();

  const totalR1Input  = finalMsg1.usage?.input_tokens  || 0;
  const totalR1Output = finalMsg1.usage?.output_tokens || 0;

  console.log('[llamarAgente] R1 stop_reason:', finalMsg1.stop_reason,
    '| tokens:', totalR1Input + totalR1Output,
    '| cache_read:', finalMsg1.usage?.cache_read_input_tokens || 0);

  // CHECK 1: verificarDobleRespuesta — descarta texto pre-tool si corresponde
  const checkDoble = supervisor.verificarDobleRespuesta(textoR1, finalMsg1.stop_reason);
  if (!checkDoble.emitir) textoR1 = '';

  // ── Si end_turn → emitir R1 y retornar ───────────────────────────────────
  if (finalMsg1.stop_reason === 'end_turn') {
    if (textoR1) {
      const checkVerb = supervisor.verificarVerbalizacion(textoR1);
      if (!checkVerb.limpio) {
        console.warn('[supervisor] Verbalización R1:', checkVerb.fraseDetectada);
      }
      emit('delta', { texto: textoR1 });
    }
    return {
      texto:        textoR1,
      toolsUsadas:  [],
      usage:        { input_tokens: totalR1Input, output_tokens: totalR1Output },
      stopReasonR1: 'end_turn',
      saturado:     false,
    };
  }

  // ── Si tool_use → ejecutar tool + Ronda 2 ────────────────────────────────
  const toolUseBlock = finalMsg1.content.find(b => b.type === 'tool_use');

  if (!toolUseBlock) {
    console.error('[llamarAgente] stop_reason=tool_use pero no hay tool_use block');
    return {
      texto:        '',
      toolsUsadas:  [],
      usage:        { input_tokens: totalR1Input, output_tokens: totalR1Output },
      stopReasonR1: 'error',
      saturado:     false,
    };
  }

  const toolsUsadas = [toolUseBlock.name];

  emit('tool_start', { tool: toolUseBlock.name, input: toolUseBlock.input });
  const toolResult = await ejecutarTool(toolUseBlock, empresa_id, user_id);
  emit('tool_end', { ok: toolResult.ok, mensaje: toolResult.mensaje });

  // Serializar tool result para R2
  const toolResultContent = toolResult.ok
    ? JSON.stringify({
        mensaje:    toolResult.mensaje,
        ...(toolResult.datos            !== undefined && { datos:             toolResult.datos            }),
        ...(toolResult.choques          !== undefined && { choques:           toolResult.choques          }),
        ...(toolResult.scope_completados !== undefined && { scope_completados: toolResult.scope_completados }),
      })
    : `Error: ${toolResult.mensaje}`;

  // ── RONDA 2 — stream real-time ────────────────────────────────────────────
  let textoR2  = '';
  let stream2;

  try {
    stream2 = anthropic.messages.stream({
      model:      MODEL,
      max_tokens: 2000,
      system:     [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
      // Sin tools en R2 — evita loops
      messages:   [
        ...input.messages,
        { role: 'assistant', content: finalMsg1.content },
        {
          role:    'user',
          content: [{
            type:        'tool_result',
            tool_use_id: toolUseBlock.id,
            content:     toolResultContent,
          }],
        },
      ],
    });

    for await (const event of stream2) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        textoR2 += event.delta.text;
        emit('delta', { texto: event.delta.text });
      }
    }
  } catch (err) {
    if (esErrorSaturacion(err)) {
      const msg = mensajeSaturacionAleatorio();
      emit('delta', { texto: msg });
      return { texto: msg, toolsUsadas, usage: { input_tokens: totalR1Input, output_tokens: totalR1Output }, stopReasonR1: 'tool_use', saturado: true };
    }
    throw err;
  }

  const finalMsg2 = await stream2.finalMessage();

  // CHECK 2: verificarVerbalizacion en R2 (log solo, no abortar)
  const checkVerbR2 = supervisor.verificarVerbalizacion(textoR2);
  if (!checkVerbR2.limpio) {
    console.warn('[supervisor] Verbalización R2:', checkVerbR2.fraseDetectada);
  }

  console.log('[llamarAgente] R2 completo. tokens acumulados:',
    (totalR1Input + totalR1Output) + (finalMsg2.usage?.input_tokens || 0) + (finalMsg2.usage?.output_tokens || 0));

  return {
    texto:        textoR2,
    toolsUsadas,
    usage: {
      input_tokens:  totalR1Input  + (finalMsg2.usage?.input_tokens  || 0),
      output_tokens: totalR1Output + (finalMsg2.usage?.output_tokens || 0),
    },
    stopReasonR1: 'tool_use',
    saturado:     false,
    toolResult,   // expuesto para que flujoModificar pueda inspeccionar
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 3 — dispatchListar()
// ═══════════════════════════════════════════════════════════════════════════════

async function dispatchListar({ mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id }) {
  return await llamarAgente({
    agenteModule: agenteListar,
    input: agenteListar.construirInput({ mensaje, historial, txn_id: txnId, empresa_context }),
    emit, empresa_id, user_id,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 4 — dispatchCrear()
// ═══════════════════════════════════════════════════════════════════════════════

async function dispatchCrear({ mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id }) {
  return await llamarAgente({
    agenteModule: agenteCrear,
    input: agenteCrear.construirInput({ mensaje, historial, txn_id: txnId, empresa_context }),
    emit, empresa_id, user_id,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 5 — formatearContexto() + dispatchConv()
// ═══════════════════════════════════════════════════════════════════════════════

// Co-extraída de nikoService.js (función pura: objeto → string).
// Convierte el resultado de obtenerContextoFinanciero() en texto para el prompt.
function formatearContexto(contexto) {
  const {
    meses_disponibles,
    ultimo_mes_con_datos,
    resumenes_por_mes,
    datos_manuales,
    patrones_pendientes,
    reglas_activas,
    es_primera_sesion,
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

  // ── Bloque ESTADO DEL CLIENTE ─────────────────────────────────────────────
  const bloqueEstado = es_primera_sesion === true
    ? `\n\n═════ ESTADO DEL CLIENTE ═════\n\nes_primera_sesion: true\n→ Usa la presentación formal completa en este mensaje.`
    : `\n\n═════ ESTADO DEL CLIENTE ═════\n\nes_primera_sesion: false\n→ Cliente recurrente. Saluda de forma casual, sin presentarte.`;

  return `DATOS FINANCIEROS DISPONIBLES\n\n${encabezado}${bloqueManual}${bloquePatrones}${bloqueReglas}${bloqueEstado}`;
}

async function dispatchConv({ mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id, ctxObj = null }) {
  // ctxObj: si viene pre-cargado desde chatWithNikoStreamV2, se reutiliza (evita doble fetch).
  // Si no viene (llamada directa standalone), se carga aquí. Fail-open en ambos casos.
  let ctxTexto = '';
  try {
    const obj = ctxObj || await obtenerContextoFinanciero(empresa_id);
    if (obj) ctxTexto = formatearContexto(obj);
  } catch (err) {
    console.error('[dispatchConv] Error cargando contexto financiero:', err.message);
  }
  return await llamarAgente({
    agenteModule: agenteConv,
    input: agenteConv.construirInput({ mensaje, historial, txn_id: txnId, empresa_context, contexto_financiero: ctxTexto }),
    emit, empresa_id, user_id,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 6a — supervisorLLM()
// ═══════════════════════════════════════════════════════════════════════════════
//
// Llama a Niko-Madre en modo SUPERVISIÓN cuando el validador programático
// detecta posible alucinación y la BD la confirma.
// Retorna { veredicto: 'ok'|'retry'|'fallback', razon, tipo_error }.
// Máx 2 iteraciones; fail-open (veredicto='ok') ante saturación o JSON inválido.

async function supervisorLLM({ accion, toolsUsadas, textoCandidato, iteracion = 1 }) {
  if (iteracion > 2) {
    console.warn('[supervisor] Máx iteraciones alcanzado. Fallback.');
    return { veredicto: 'fallback', razon: 'max_iteraciones', tipo_error: null };
  }

  const anthropic = new Anthropic();

  const input = agenteMadre.construirInputSupervision({
    agente:          'modificar',
    accion_esperada: accion,
    tools_usadas:    toolsUsadas,
    texto_agente:    textoCandidato,
    turno:           iteracion,
  });

  let response;
  try {
    response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 200,
      system:     input.system,
      messages:   input.messages,
    });
  } catch (err) {
    if (esErrorSaturacion(err)) {
      console.warn('[supervisor] Saturación. Fail-open OK.');
      return { veredicto: 'ok', razon: 'fallback_saturacion', tipo_error: null };
    }
    throw err;
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const texto = textBlock?.text || '';

  const parsed = agenteMadre.parseRespuestaJSON(texto, 'supervision');

  if (!parsed || !parsed.veredicto) {
    console.warn('[supervisor] JSON inválido. Fail-open OK.');
    return { veredicto: 'ok', razon: 'json_invalido', tipo_error: null };
  }

  console.log('[supervisor] veredicto:', parsed.veredicto, '| tipo_error:', parsed.tipo_error);
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 6b — flujoModificar() — fase CONTEXTO (Pasos 1+2)
// ═══════════════════════════════════════════════════════════════════════════════

async function flujoModificar({ mensaje, historial, txnId, steps, nikoId, nikoList, accion, empresa_context, empresa_id, user_id, emit }) {
  // PASO 1 — Resolver UUID (3 fuentes en cascada)
  let uuid_resuelto = nikoId;
  // Fuente 2: extraer NIKO_ID del historial (lo emitió el agente contexto en turno anterior)
  if (!uuid_resuelto && txnId) {
    uuid_resuelto = markers.extraerNikoIdUltimo(historial, txnId);
  }
  // Fuente 3: usuario eligió número de una lista (NIKO_LIST)
  if (!uuid_resuelto) {
    uuid_resuelto = markers.resolverEleccionDeLista(historial, txnId, mensaje);
  }

  // PASO 2 — Sin UUID → fase CONTEXTO (listar + pedir elegir)
  if (!uuid_resuelto) {
    return await llamarAgente({
      agenteModule: agenteCtx,
      input: agenteCtx.construirInput({ mensaje, historial, txn_id: txnId, empresa_context, accion }),
      emit, empresa_id, user_id,
    });
  }

  // PASO 3 — Con UUID → fase MODIFICAR (UUID inyectado en el prompt)
  // esConfirmacion SOLO si ya hay una propuesta emitida (STEP:2), no en T2 de identificación
  const hayPropuesta = Array.isArray(steps) && steps.some(s => s.includes('modificar_pregunta'));

  // esCompletado: detectar si agenteCtx emitió NIKO_COMPLETADO:true en el historial.
  // Solo relevante para editar. Mutuamente excluyente con hayPropuesta:
  //   T2 (primer agenteMod): hayPropuesta=false → esCompletado puede activar [ME.0]
  //   T3 (confirma cambio): hayPropuesta=true  → esCompletado=false → [ME.0] no se inyecta
  const esCompletado = accion === 'editar' && !hayPropuesta && Array.isArray(historial) && historial.some(msg => {
    const t = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
    return /<!--\s*NIKO_COMPLETADO:true\s*-->/i.test(t);
  });

  const resultadoMod = await llamarAgente({
    agenteModule: agenteMod,
    input: agenteMod.construirInput({ mensaje, historial, txn_id: txnId, empresa_context, accion, nikoId: uuid_resuelto, esConfirmacion: hayPropuesta && markers.esMensajeAfirmativo(mensaje), esCompletado }),
    emit, empresa_id, user_id,
  });

  // PASO 4 — verificarToolEjecutada (primer check anti-phantom)
  const accionParaValidador = accion === 'eliminar' ? 'eliminar' : 'actualizar';
  const checkTool = supervisor.verificarToolEjecutada(resultadoMod.toolsUsadas, accionParaValidador, resultadoMod.texto);

  if (checkTool.ok) {
    return resultadoMod;  // tool ejecutada de verdad → OK
  }

  // PASO 5 — Tool NO ejecutada → verificarBD (¿falso positivo del detector?)
  const tituloMatch = resultadoMod.texto.match(/\*\*(.+?)\*\*/);
  const tituloParaBD = tituloMatch ? tituloMatch[1] : null;
  const checkBD = await supervisor.verificarBD(empresa_id, accion, tituloParaBD);
  if (checkBD.confirmadoEnBD) {
    console.log('[flujoModificar] verificarBD confirmó: falso positivo, la acción SÍ ocurrió.');
    return resultadoMod;  // el detector se equivocó, la BD confirma el cambio
  }

  // PASO 6 — Alucinación confirmada → supervisorLLM + retry (máx 2)
  for (let iter = 1; iter <= 2; iter++) {
    const veredicto = await supervisorLLM({
      accion, toolsUsadas: resultadoMod.toolsUsadas, textoCandidato: resultadoMod.texto, iteracion: iter,
    });

    if (veredicto.veredicto === 'ok') {
      console.log('[flujoModificar] supervisorLLM: OK (confiar).');
      return resultadoMod;
    }

    if (veredicto.veredicto === 'retry') {
      console.warn('[flujoModificar] supervisorLLM: RETRY iter', iter, '— forzando tool_choice=any');
      const retryMod = await llamarAgente({
        agenteModule: agenteMod,
        input: agenteMod.construirInput({ mensaje, historial, txn_id: txnId, empresa_context, accion, nikoId: uuid_resuelto, esConfirmacion: true }),
        emit, empresa_id, user_id, toolChoice: 'any',
      });
      const reCheck = supervisor.verificarToolEjecutada(retryMod.toolsUsadas, accionParaValidador, retryMod.texto);
      if (reCheck.ok) {
        console.log('[flujoModificar] Retry exitoso: tool ejecutada.');
        return retryMod;
      }
      // si el retry tampoco ejecutó, sigue el loop (iter 2)
    }

    if (veredicto.veredicto === 'fallback') {
      console.warn('[flujoModificar] supervisorLLM: FALLBACK.');
      break;
    }
  }

  // PASO 7 — CATÁSTROFE (2 retries sin éxito) → disculpa honesta
  console.error('[flujoModificar] CATÁSTROFE: no se pudo confirmar la acción tras retries.');
  const msgCatastrofe = 'Disculpa, tuve un problema al procesar eso. ¿Puedes intentarlo de nuevo?';
  emit('delta', { texto: msgCatastrofe });
  return { texto: msgCatastrofe, toolsUsadas: resultadoMod.toolsUsadas, usage: resultadoMod.usage, stopReasonR1: 'catastrofe', saturado: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 7 — routingShortcut() + llamarMadreJSON() + extraerAccionDelTxn()
// ═══════════════════════════════════════════════════════════════════════════════

// ─── routingShortcut ──────────────────────────────────────────────────────────
//
// Función PURA de routing sin LLM (0 tokens, 0 latencia).
// Retorna { intent, accion, confianza, motivo } o null si no puede decidir.
// Si confianza < 0.85 → el router debe llamar llamarMadreJSON como fallback.

function routingShortcut(mensaje, txnId, steps, nikoId, nikoList, accion) {
  // ── CAPA 1 — Continuación de TXN activo (confianza 1.0) ─────────────────
  if (txnId && Array.isArray(steps) && steps.length > 0) {

    // A) NIKO_LIST presente + usuario elige número ordinal
    if (nikoList && /^(el\s+)?\d+\s*$|el\s+(primero|segundo|tercero)/i.test(mensaje.trim())) {
      return { intent: 'modificar', accion, confianza: 1.0, motivo: 'eleccion_lista' };
    }

    // B) NIKO_ID presente + mensaje afirmativo
    if (nikoId && markers.esMensajeAfirmativo(mensaje)) {
      return { intent: 'modificar', accion, confianza: 1.0, motivo: 'confirmacion_modificar' };
    }

    // C) NIKO_ID presente + negativo explícito
    if (nikoId && /^(no\b|mejor\s+no|cancela|d[eé]jalo|no\s+lo|dejalo)/i.test(mensaje.trim())) {
      return { intent: 'conversacion', accion: null, confianza: 1.0, motivo: 'cancelacion' };
    }

    // D) TXN activo sin NIKO_ID (Contexto aún identificando)
    if (!nikoId && steps.some(s => s.includes('contexto'))) {
      return { intent: 'modificar', accion, confianza: 0.9, motivo: 'respuesta_contexto' };
    }

    // E) TXN de crear activo (Crear preguntó descripción/hora/fecha)
    if (steps.some(s => s.includes('crear'))) {
      // (1) CANCELACIÓN explícita del crear → soltar y cerrar limpio
      // Solo frases INEQUÍVOCAS: "olvídalo" o "cancela" no pueden ser respuestas de descripción.
      // "no" / "no gracias" son respuestas válidas a "¿Le agregamos nota?" → NO cancelan el crear.
      const esCancelacion =
        /\bolv[ií]dalo\b/i.test(mensaje) ||
        /^cancela(r)?\b/i.test(mensaje.trim());
      if (esCancelacion) {
        return { intent: 'conversacion', accion: 'cancelar_crear', confianza: 0.9, motivo: 'cancelacion_crear' };
      }

      // (2) CAMBIO DE TEMA claro (estructura interrogativa/imperativa, no palabras sueltas)
      const esCambioTemaClaro =
        /mu[eé]strame\s+(los\s+|mis\s+)?recordatorios/i.test(mensaje) ||
        /qu[eé]\s+tengo\s+(agendado|pendiente)/i.test(mensaje) ||
        /qu[eé]\s+(recordatorios|pendientes)\s+(tengo|hay)/i.test(mensaje) ||
        /lista(me)?\s+(los\s+|mis\s+)?recordatorios/i.test(mensaje) ||
        /mis\s+recordatorios\s+(pendientes|completos|de\s+hoy)/i.test(mensaje) ||
        /c[oó]mo\s+(van|est[aá]n?|voy\s+de)\s+(mis\s+)?(venta|finanza|gasto|ingreso|margen)/i.test(mensaje) ||
        /cu[aá]nto\s+(gast[eé]|cobr[eé]|pagu[eé])/i.test(mensaje);

      if (esCambioTemaClaro) return null; // cae a Capa 2 / Madre LLM → atiende el nuevo tema

      // Caso normal: continuar el crear
      return { intent: 'crear', accion: null, confianza: 0.95, motivo: 'continuar_crear' };
    }
  }

  // ── CAPA 2 — Patrones high-confidence sin TXN activo ────────────────────
  const msg = mensaje.toLowerCase().trim();

  // LISTAR completados (prioridad sobre listar genérico)
  if (/mu[eé]strame\s+(los\s+)?completados|qu[eé]\s+complet[eé]|recordatorios\s+hechos|los\s+hechos/i.test(msg)) {
    return { intent: 'listar', accion: 'completados', confianza: 0.95, motivo: 'listar_completados' };
  }

  // LISTAR pendientes
  // FIX: agrega "mis recordatorios" y "qué pendientes tengo"
  if (/qu[eé]\s+tengo\s+(agendado|pendiente)|qu[eé]\s+recordatorios|mu[eé]strame\s+(los\s+)?recordatorios|lista(me)?\s+los\s+recordatorios|tengo\s+algo\s+pendiente|mis\s+recordatorios\b|qu[eé]\s+pendientes\s+tengo/i.test(msg)) {
    return { intent: 'listar', accion: 'pendientes', confianza: 0.95, motivo: 'listar_pendientes' };
  }

  // CREAR
  // FIX: agrega "necesito que me recuerdes" y "quiero programar"
  if (/ag[eé]ndame\b|recu[eé]rdame\b|crea\s+(un\s+)?recordatorio|anota\s+(un\s+)?recordatorio|pon\s+(un\s+)?recordatorio|necesito\s+que\s+me\s+recuerdes?\b|quiero\s+programar\b/i.test(msg)) {
    return { intent: 'crear', accion: null, confianza: 0.90, motivo: 'crear_explicito' };
  }

  // MODIFICAR completar
  // FIX: agrega "ya terminé"
  if (/marca(r?)\s+.{0,40}(como\s+)?(hecho|completado)|complet(a|ar)\s+.{0,40}|ya\s+hice\b.{0,30}|lo\s+hice\b.{0,30}|ya\s+termin[eé](?=\s|$)/i.test(msg)) {
    return { intent: 'modificar', accion: 'completar', confianza: 0.95, motivo: 'modificar_completar' };
  }

  // MODIFICAR eliminar
  // FIX: agrega "borra el/la X" sin requerir la palabra "recordatorio"
  if (/elimina(r?)\s+.{0,40}|borra(r?)\s+(el|la)\s+|borra(r?)\s+.{0,40}recordatorio|sac(a|ar)\s+.{0,40}recordatorio|ya\s+no\s+necesito\s+.{0,40}/i.test(msg)) {
    return { intent: 'modificar', accion: 'eliminar', confianza: 0.95, motivo: 'modificar_eliminar' };
  }

  // MODIFICAR editar
  // FIX: agrega "cambia el/la/los X" para casos sin preposición "a/para/de"
  if (/cambia(r?)\s+.{0,30}(a|para|de)\s+.{0,30}|cambia(r?)\s+(el|la|los|un|una|su)\s+|edita(r?)\s+.{0,40}|modifica(r?)\s+.{0,40}|mueve(r?)\s+.{0,40}(al|a\s+las?|para\s+el)|actualiza(r?)\s+.{0,40}|renombra(r?)\s+/i.test(msg)) {
    return { intent: 'modificar', accion: 'editar', confianza: 0.90, motivo: 'modificar_editar' };
  }

  // MODIFICAR reactivar
  if (/reactiva(r?)\s+|vuelve\s+a\s+poner\s+pendiente|desmarca(r?)\s+.{0,40}(como\s+)?hecho|lo\s+dej[eé]\s+pendiente\s+de\s+nuevo/i.test(msg)) {
    return { intent: 'modificar', accion: 'reactivar', confianza: 0.95, motivo: 'modificar_reactivar' };
  }

  // CONVERSACION — saludos, finanzas, preguntas generales
  // FIX: capa 2 no tenía ningún patrón para conversacion → caían todos al LLM.
  // Posición: al final de capa 2, solo llega aquí si no matcheó nada de recordatorios.
  if (/\b(hola|gracias|adi[oó]s|buenos\s+(d[ií]as|tardes|noches))\b|\b(margen|finanzas|financiero|financieramente|proveedor|categori[zs]|gast[oéeó]|cobr[eé]|pagué)\b|qu[eé]\s+me\s+recomiend|qu[eé]\s+opinas|c[oó]mo\s+estuvo|c[oó]mo\s+est[aá]\s+(mi|el|la)\b|c[oó]mo\s+voy\b|ay[uú]dame\s+(a\s+)?|expl[ií]came\b|cu[aá]nto\s+(gast[eé]|cobr[eé]|pagu[eé])|entender\s+(mis|los)\s+(gasto|ingreso)/i.test(msg)) {
    return { intent: 'conversacion', accion: null, confianza: 0.85, motivo: 'conversacion_detectada' };
  }

  // ── CAPA 3 — No hay match → necesita Madre LLM ──────────────────────────
  return null;
}

// ─── extraerAccionDelTxn ──────────────────────────────────────────────────────
//
// Lee los steps del TXN activo y extrae la sub-acción codificada
// como "accion=X" en los marcadores de Contexto/Modificar.

function extraerAccionDelTxn(steps) {
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const m = step.match(/accion=(\w+)/);
    if (m) return m[1]; // 'completar' | 'editar' | 'eliminar' | 'reactivar'
  }
  return null;
}

// ─── llamarMadreJSON ──────────────────────────────────────────────────────────
//
// Fallback LLM para routing cuando routingShortcut retorna null o confianza < 0.85.
// Llama a Niko-Madre en modo ROUTING, retorna { intent, accion, confianza, motivo }.

async function llamarMadreJSON({ mensaje, historial, txnId, steps, nikoId, nikoList, accion }) {
  const anthropic = new Anthropic();

  const nikoListActivo = !!(nikoList && Object.keys(nikoList).length > 0);

  const input = agenteMadre.construirInputRouting({
    mensaje,
    historial:        (historial || []).slice(-10), // últimas 10 msgs para Madre
    txn_activo:       txnId  || null,
    niko_id_activo:   nikoId || null,
    niko_list_activo: nikoListActivo,
    steps_txn:        steps  || [],
  });

  let response;
  try {
    response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 200,
      system:     input.system,
      messages:   input.messages,
    });
  } catch (err) {
    if (esErrorSaturacion(err)) {
      console.warn('[madre.routing] Saturación. Fallback a conversacion.');
      return { intent: 'conversacion', accion: null, confianza: 0.5, motivo: 'fallback_saturacion' };
    }
    throw err;
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const texto = textBlock?.text || '';

  const parsed = agenteMadre.parseRespuestaJSON(texto, 'routing');

  if (!parsed || !parsed.agente) {
    console.warn('[madre.routing] JSON inválido o sin agente. Default a conversacion.');
    return { intent: 'conversacion', accion: null, confianza: 0.5, motivo: 'json_invalido' };
  }

  console.log('[madre.routing] intent:', parsed.agente, '| accion:', parsed.accion, '| confianza:', parsed.confianza);

  return {
    intent:    parsed.agente,
    accion:    parsed.accion    || null,
    confianza: parsed.confianza || 0.7,
    motivo:    parsed.razonamiento || 'madre_llm',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 8 — chatWithNikoStreamV2()
// ═══════════════════════════════════════════════════════════════════════════════
//
// Función principal que orquesta un turno completo de Niko V2.
// Misma firma que el monolito (chatWithNikoStream) para que el switch sea
// transparente: solo cambia el require en la ruta HTTP.
//
// Eventos emitidos (mismo contrato que monolito):
//   delta      → { texto }
//   tool_start → { tool, input }
//   tool_end   → { ok, mensaje }
//   done       → { respuesta, eerr_ampliado_recien_revelado, meta, saturado }

async function chatWithNikoStreamV2({ mensaje, historial, empresa_id, user_id }, emit) {
  const inicio   = Date.now();
  const supabase = getSupabase();

  // ─── ETAPA 0 — Cargar empresa_context + contexto financiero (una sola vez) ──

  const { data: empresa, error: empresaError } = await supabase
    .from('empresas')
    .select('nombre, giro, representante_nombre, representante_rol, tratamiento')
    .eq('id', empresa_id)
    .maybeSingle();

  if (empresaError || !empresa) {
    console.error('[chatWithNikoStreamV2] Empresa no encontrada:', empresa_id, empresaError?.message);
    emit('done', {
      respuesta: 'No pude cargar los datos de tu empresa. Intenta de nuevo.',
      eerr_ampliado_recien_revelado: false,
      meta: {}, saturado: false,
    });
    return;
  }

  const empresa_context = {
    nombre:        empresa.nombre               || 'tu empresa',
    giro:          empresa.giro                 || 'su rubro',
    representante: empresa.representante_nombre || 'jefe',
    rol:           empresa.representante_rol    || 'dueño/a',
    tratamiento:   empresa.tratamiento          || 'tu',
  };

  let ctxObjFinanciero = null;
  try {
    ctxObjFinanciero = await obtenerContextoFinanciero(empresa_id);
  } catch (e) {
    console.error('[chatWithNikoStreamV2] Error contexto financiero:', e.message);
  }

  // ─── ETAPA 1 — Extraer estado del TXN del historial ──────────────────────────

  let txnId      = markers.extraerTxnActivo(historial);
  let steps      = txnId ? markers.extraerStepsDelTxn(historial, txnId)      : [];
  let nikoId     = txnId ? markers.extraerNikoIdUltimo(historial, txnId)     : null;
  let nikoList   = txnId ? markers.extraerNikoListUltimo(historial, txnId)   : null;
  let accionPrev = extraerAccionDelTxn(steps);
  if (!txnId) txnId = markers.generarTxnId();

  console.log('[chatWithNikoStreamV2] TXN:', txnId,
    '| steps:', steps.length,
    '| nikoId:', !!nikoId,
    '| accionPrev:', accionPrev);

  // ─── ETAPA 2 — Routing (shortcut → Madre LLM si null o confianza < 0.85) ────

  let routing = routingShortcut(mensaje, txnId, steps, nikoId, nikoList, accionPrev);
  if (!routing || routing.confianza < 0.85) {
    console.log('[chatWithNikoStreamV2] Shortcut insuficiente. Llamando Madre LLM...');
    routing = await llamarMadreJSON({
      mensaje, historial, txnId, steps, nikoId, nikoList, accion: accionPrev,
    });
  }

  console.log('[chatWithNikoStreamV2] routing:', routing.intent,
    '| accion:', routing.accion,
    '| motivo:', routing.motivo,
    '| confianza:', routing.confianza);

  // ─── ETAPA 3 — Dispatch al agente correcto ───────────────────────────────────

  let resultado;

  switch (routing.intent) {

    case 'crear':
      resultado = await dispatchCrear({
        mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id,
      });
      break;

    case 'listar':
      resultado = await dispatchListar({
        mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id,
      });
      break;

    case 'conversacion':
      resultado = await dispatchConv({
        mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id,
        ctxObj: ctxObjFinanciero,   // reutilizar el objeto ya cargado en ETAPA 0
      });
      break;

    case 'modificar':
    case 'contexto':   // madre puede devolver 'contexto' para completar/editar/eliminar/reactivar → es fase 1 de modificar
      resultado = await flujoModificar({
        mensaje, historial, txnId, steps, nikoId, nikoList,
        accion:         routing.accion || accionPrev,
        empresa_context, empresa_id, user_id, emit,
      });
      break;

    default:
      console.warn('[chatWithNikoStreamV2] Intent desconocido:', routing.intent, '→ fallback conversacion');
      resultado = await dispatchConv({
        mensaje, historial, txnId, empresa_context, emit, empresa_id, user_id,
        ctxObj: ctxObjFinanciero,
      });
  }

  // ─── ETAPA 4 — Primera sesión ────────────────────────────────────────────────
  // ctxObjFinanciero ya cargado en ETAPA 0 — sin refetch.

  if (ctxObjFinanciero?.es_primera_sesion === true) {
    const { error: updateError } = await supabase
      .from('empresas')
      .update({ primera_conversacion_niko_completada: true })
      .eq('id', empresa_id)
      .eq('primera_conversacion_niko_completada', false);

    if (updateError) {
      console.warn('[chatWithNikoStreamV2] No se pudo marcar primera sesión:', updateError.message);
    } else {
      console.log('[chatWithNikoStreamV2] Primera sesión marcada completada para empresa:', empresa_id);
    }
  }

  // ─── ETAPA 5 — Flag EERR Ampliado ────────────────────────────────────────────

  let eerrAmpliadoRecienRevelado = false;
  try {
    const { data: flags } = await supabase
      .from('empresas')
      .select('eerr_ampliado_revelado, eerr_ampliado_niko_notificado')
      .eq('id', empresa_id)
      .maybeSingle();

    if (flags?.eerr_ampliado_revelado && !flags?.eerr_ampliado_niko_notificado) {
      const { error: updErr } = await supabase
        .from('empresas')
        .update({ eerr_ampliado_niko_notificado: true })
        .eq('id', empresa_id);

      if (!updErr) eerrAmpliadoRecienRevelado = true;
    }
  } catch (errFlag) {
    console.warn('[chatWithNikoStreamV2] Error EERR ampliado flag:', errFlag.message);
  }

  // ─── ETAPA 6 — Persistir y terminar ──────────────────────────────────────────

  const latencia_ms   = Date.now() - inicio;
  const tokens_usados = (resultado.usage?.input_tokens || 0) + (resultado.usage?.output_tokens || 0);

  emit('done', {
    respuesta: resultado.texto,
    eerr_ampliado_recien_revelado: eerrAmpliadoRecienRevelado,
    meta: {
      intent:       routing.intent,
      accion:       routing.accion,
      txn_id:       txnId,
      tools_usadas: resultado.toolsUsadas || [],
      tokens_usados,
    },
    saturado: resultado.saturado || false,
  });

  // Fire-and-forget: persistir respuesta del assistant
  supabase
    .from('niko_conversaciones')
    .insert({
      empresa_id,
      user_id,
      rol:             'assistant',
      mensaje:         resultado.texto,
      tools_invocadas: resultado.toolsUsadas || [],
      tokens_usados,
      latencia_ms,
    })
    .then(({ error: e }) => {
      if (e) console.error('[chatWithNikoStreamV2] Error persistiendo conversación:', e.message);
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ejecutarTool,
  NIKO_TOOLS,
  getSupabase,
  markers,
  esErrorSaturacion,
  mensajeSaturacionAleatorio,
  llamarAgente,
  dispatchListar,
  dispatchCrear,
  dispatchConv,
  formatearContexto,
  supervisorLLM,
  flujoModificar,
  routingShortcut,
  extraerAccionDelTxn,
  llamarMadreJSON,
  chatWithNikoStreamV2,
};
