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
// TODO — BLOQUES PENDIENTES
// ═══════════════════════════════════════════════════════════════════════════════
//
// Bloque 1: supervisor.js (fusión validador.js + supervisorPhantom.js)
//   → verificarToolEjecutada, verificarDobleRespuesta, verificarVerbalizacion,
//     verificarBD, esPreguntaConfirmacionFinal, esRespuestaConfirmatoria,
//     preguntoNota, esPhantomDeEscritura
//
// Bloque 2: llamarAgente(agenteModule, input, emit, empresa_id, user_id)
//   → wrapper genérico R1 buffered + checks supervisor + R2 streamed
//
// Bloque 3: agenteListar (agents/listar.js)
// Bloque 4: agenteCrear (agents/crear.js)
// Bloque 5: agenteConv (agents/conversacion.js + contextoFinanciero)
// Bloque 6: flujoModificar (agents/contexto.js + agents/modificar.js + retry)
// Bloque 7: routingShortcut + llamarMadreJSON (agents/madre.js)
// Bloque 8: chatWithNikoStreamV2() — función principal exportable
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Exports (Bloque 0 — infraestructura base) ────────────────────────────────

module.exports = {
  ejecutarTool,
  NIKO_TOOLS,
  getSupabase,
  markers,
  esErrorSaturacion,
  mensajeSaturacionAleatorio,
};
