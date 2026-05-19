'use strict';

const Anthropic                        = require('@anthropic-ai/sdk');
const { createClient }                 = require('@supabase/supabase-js');
const { buildSystemPrompt }            = require('./systemPrompt');
const { obtenerContextoFinanciero }    = require('./contextoFinanciero');

const MODEL = 'claude-sonnet-4-6';

// ─── Mensaje de incidente (saturación / error transitorio) ───────────────────
// Se usa cuando Anthropic devuelve 529, 503, 502 o 504.
// Niko responde de forma empática sin exponer el error técnico.

const MENSAJE_INCIDENTE = 'Disculpa, parece que se me cayó la señal. ¿Podrías repetir lo que me pediste?';

const STATUS_SATURACION = new Set([529, 503, 502, 504]);

function esErrorSaturacion(err) {
  return err && typeof err.status === 'number' && STATUS_SATURACION.has(err.status);
}

// Alias mantenido para compatibilidad con todos los call sites del archivo
function mensajeSaturacionAleatorio() {
  return MENSAJE_INCIDENTE;
}

// ─── Tool spec para Claude API ────────────────────────────────────────────────
//
// Niko dispone de esta tool para guardar reglas de categorización cuando el
// usuario confirma explícitamente cómo clasificar un patrón de transacciones.

const NIKO_TOOLS = [
  {
    name: 'guardar_regla_categorizacion',
    description: "Guarda una regla permanente que asocia un patrón de texto con una categoría del EERR. Llama esta tool ÚNICAMENTE cuando el usuario confirmó de forma explícita y clara (ejemplos de confirmación válida: 'sí', 'dale', 'listo', 'hagámoslo', 'perfecto', 'ya', 'ok', 'bueno', 'sí po'). NUNCA la llames si el usuario dudó, preguntó algo más, cambió de tema, o no respondió con claridad afirmativa. Si hay duda, primero aclara y espera confirmación. IMPORTANTE: Antes de llamar esta tool, valida con el usuario que la categoría elegida sea coherente con el tipo de las transacciones (Ventas/Otros ingresos solo para ingresos; el resto solo para egresos). Si el bloque es mixto (hay tanto ingresos como egresos con ese patrón), pregúntale al usuario antes de aplicar. Si después de aplicar la regla recibes incoherencias_detectadas en el resultado, informa al usuario y pregunta cómo categorizar las transacciones pendientes.",
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
    description: "Crea un recordatorio en la pestaña 'Creados por mí' del usuario. Llama esta tool ÚNICAMENTE cuando el usuario te pide explícitamente que le recuerdes algo Y ya tienes la fecha exacta confirmada (formato YYYY-MM-DD). NO llames la tool si falta la fecha o si la fecha es relativa sin confirmar (ej: 'en 3 días', 'la próxima semana'). En esos casos primero calcula la fecha absoluta y confirma con el usuario antes de llamar la tool.",
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
    description: "Lista los recordatorios del usuario para los PRÓXIMOS 3 DÍAS (hoy y próximos 3). Úsala cuando el usuario te pregunta '¿qué tengo pendiente?' o necesitas identificar un recordatorio para editar/eliminar. Si el usuario pide recordatorios más allá de 3 días, NO llames la tool — invítalo a revisar la pestaña /recordatorios.",
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
      },
      required: [],
    },
  },
  {
    name: 'actualizar_recordatorio',
    description: "Actualiza un recordatorio existente. Cubre TODOS los casos: editar (título/descripción/fecha) Y completar/descompletar. Llama esta tool SOLO después de identificar el recordatorio con listar_recordatorios y obtener confirmación del usuario.",
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
    description: "Elimina un recordatorio definitivamente. Acción irreversible. Llama esta tool SOLO después de identificar con listar_recordatorios y recibir DOBLE confirmación del usuario.",
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

    // Para completados (reactivar): buscar desde el 1er día del mes actual,
    // ya que los registros completados suelen tener fechas pasadas.
    // Para pendientes: ventana de 3 días (comportamiento original).
    let diasAdelante = 3;
    let fechaDesde   = undefined;

    if (input.completado === true) {
      const hoy = new Date();
      fechaDesde   = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
        .toISOString()
        .split('T')[0];
      diasAdelante = 365; // cubrir completados futuros también
    }

    const resultado = await listarRecordatorios({
      empresa_id,
      dias_adelante:   diasAdelante,
      fecha_desde:     fechaDesde,
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
      ok:             true,
      mensaje:        `Encontré ${lista.length} recordatorio${lista.length !== 1 ? 's' : ''}.`,
      datos:          lista,
      scope_completados: input.completado === true ? 'mes_actual' : null,
    };
  }

  if (name === 'actualizar_recordatorio') {
    const { actualizarRecordatorio } = require('../../routes/recordatorios');
    const supabase = getSupabase();

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

    // Verificar choques si el cambio modifica fecha, hora o reactiva el recordatorio
    const cambioTemporal = input.fecha_vencimiento !== undefined ||
                           input.hora_vencimiento !== undefined ||
                           input.completado === false;

    let choquesAviso = null;

    if (cambioTemporal && resultado.recordatorio) {
      const fechaFinal = resultado.recordatorio.fecha_vencimiento;
      const horaFinal  = resultado.recordatorio.hora_vencimiento;

      if (fechaFinal && horaFinal) {
        const { data: choquesData, error: choquesError } = await supabase.rpc(
          'verificar_choque_recordatorio',
          {
            p_empresa_id: empresa_id,
            p_fecha:      fechaFinal,
            p_hora:       horaFinal,
          }
        );

        if (!choquesError && choquesData && choquesData.length > 0) {
          // Filtrar el propio recordatorio que se está actualizando
          const choquesFiltrados = choquesData.filter(c => c.id !== input.id);
          if (choquesFiltrados.length > 0) {
            choquesAviso = choquesFiltrados;
          }
        }
      }
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

// ════════════════════════════════════════════════════════════════════════════
// SUPERVISOR ANTI-ALUCINACIÓN DE EJECUCIÓN DE TOOLS
// ════════════════════════════════════════════════════════════════════════════
//
// Niko a veces emite frases como "Listo, marqué X como hecho" sin
// haber llamado la tool correspondiente. Estas 2 funciones detectan
// esa alucinación y permiten gatillar un retry con tool_choice: any.
//
// detectarAccionConsumada: filtro rápido de texto (0 tokens, 0 latencia).
// verificarAccionEnBD: verdad absoluta consultando Supabase (~50ms).

/**
 * Detecta si la respuesta de Niko afirma haber ejecutado una acción
 * de recordatorio (marcar, eliminar, crear, actualizar, reactivar).
 * Solo activa si el turno anterior del assistant fue una pregunta de
 * confirmación tipo "¿Confirmas que...?".
 *
 * @param {string} textoRonda - Texto generado por Niko en este turno.
 * @param {Array}  historial  - Historial de mensajes previos.
 * @returns {object|null} { accion, titulo } si detecta alucinación potencial, null si no.
 */
function detectarAccionConsumada(textoRonda, historial) {
  if (!textoRonda || typeof textoRonda !== 'string') return null;

  // Gate 1: el turno anterior debe haber sido una pregunta de confirmación
  const ultimoAssistant = [...historial].reverse().find(m => m.role === 'assistant');
  if (!ultimoAssistant) return null;
  const textoPrevio = typeof ultimoAssistant.content === 'string'
    ? ultimoAssistant.content
    : (Array.isArray(ultimoAssistant.content)
        ? ultimoAssistant.content.map(b => b.text || '').join(' ')
        : '');
  const fuePreguntaConfirmacion = /[¿?]confirmas?\b|¿confirmas/i.test(textoPrevio);
  if (!fuePreguntaConfirmacion) return null;

  // Gate 2: el texto actual debe contener una frase de acción consumada
  const patrones = [
    { regex: /listo,?\s+marqu[eé]/i,     accion: 'completar' },
    { regex: /hecho,?\s+marqu[eé]/i,     accion: 'completar' },
    { regex: /listo,?\s+complet[eé]/i,   accion: 'completar' },
    { regex: /listo,?\s+elimin[eé]/i,    accion: 'eliminar'  },
    { regex: /hecho,?\s+elimin[eé]/i,    accion: 'eliminar'  },
    { regex: /listo,?\s+borr[eé]/i,      accion: 'eliminar'  },
    { regex: /^borrado\s+/i,             accion: 'eliminar'  },
    { regex: /listo,?\s+agend[eé]/i,     accion: 'crear'     },
    { regex: /qued[oó]\s+agendado/i,     accion: 'crear'     },
    { regex: /listo,?\s+actualic[eé]/i,  accion: 'actualizar'},
    { regex: /hecho,?\s+actualic[eé]/i,  accion: 'actualizar'},
    { regex: /listo,?\s+reactiv[eé]/i,   accion: 'reactivar' },
  ];

  for (const { regex, accion } of patrones) {
    if (regex.test(textoRonda)) {
      // Extraer título mencionado (best-effort: primer texto en negritas)
      const matchTitulo = textoRonda.match(/\*\*([^*]+)\*\*/);
      const titulo = matchTitulo ? matchTitulo[1].trim() : null;
      return { accion, titulo };
    }
  }

  return null;
}

/**
 * Verifica en Supabase si la acción que Niko dice haber ejecutado
 * realmente ocurrió en BD en los últimos 10 segundos.
 *
 * @param {string} empresa_id
 * @param {string} accion - 'completar' | 'eliminar' | 'crear' | 'actualizar' | 'reactivar'
 * @param {string} titulo - Título del recordatorio mencionado por Niko
 * @returns {Promise<boolean>} true si la acción ocurrió, false si no
 */
async function verificarAccionEnBD(empresa_id, accion, titulo) {
  if (!empresa_id || !titulo) return false;

  const supabase = getSupabase();
  const haceDiezSegundos = new Date(Date.now() - 10000).toISOString();

  try {
    if (accion === 'eliminar') {
      const { data, error } = await supabase
        .from('recordatorios')
        .select('id')
        .eq('empresa_id', empresa_id)
        .ilike('titulo', titulo)
        .limit(1);
      if (error) return true; // En duda, asumir OK para no spamear retries
      return !data || data.length === 0;
    }

    const { data, error } = await supabase
      .from('recordatorios')
      .select('id, completado, updated_at, created_at')
      .eq('empresa_id', empresa_id)
      .ilike('titulo', titulo)
      .gte('updated_at', haceDiezSegundos)
      .limit(1);

    if (error) return true;
    if (!data || data.length === 0) return false;

    const rec = data[0];
    if (accion === 'completar')  return rec.completado === true;
    if (accion === 'reactivar')  return rec.completado === false;
    if (accion === 'crear')      return rec.created_at >= haceDiezSegundos;
    if (accion === 'actualizar') return rec.updated_at >= haceDiezSegundos;
    return true;
  } catch (err) {
    console.error('[supervisor] Error verificando BD:', err.message);
    return true; // En duda, asumir OK
  }
}

// ─── Detector de intención de recordatorio ────────────────────────────────────
//
// Devuelve true SOLO cuando tiene sentido forzar tool_choice: { type: 'any' }
// en Ronda 1 de Claude.
//
// Lógica:
// - CASO 1 (prioritario): Niko terminó el turno anterior con pregunta intermedia
//   (descripción, hora, fecha). La respuesta del usuario debe disparar la tool
//   directamente, sin esperar otra pregunta. Esto cubre el flujo de CREAR
//   correctamente: Niko pregunta → usuario responde → se fuerza la tool.
//
// - CASO 2: Operaciones CRUD (borrar, completar, editar, reactivar, mover) y
//   listar → forzar tool siempre porque no requieren preguntas previas.
//
// - CASO crear (sin pregunta previa): NO forzar tool. Niko debe preguntar
//   descripción ANTES de crear. El forzado ocurre en el turno siguiente (CASO 1).
//
function detectarIntencionRecordatorio(mensaje, historial) {
  if (!mensaje) return false;

  const msgLower = mensaje.toLowerCase().trim();

  // ─── CASO 1: respuesta a pregunta intermedia de Niko ─────────────────────
  // Es el caso PRIORITARIO porque cubre el flujo correcto de creación.
  if (historial && historial.length > 0) {
    const ultimoAssistant = [...historial].reverse().find(m => m.role === 'assistant');
    if (ultimoAssistant && typeof ultimoAssistant.content === 'string') {
      const ultimoTextoAssistant = ultimoAssistant.content.toLowerCase();
      const preguntaDescripcion = /agregamos.{0,15}(descripción|descripcion|nota)/.test(ultimoTextoAssistant);
      const preguntaHora        = /\b9am\b|preferencia.{0,15}hora|qué hora|que hora/.test(ultimoTextoAssistant);
      const preguntaFecha       = /qué fecha|que fecha|para cuándo|para cuando|qué día|que día/.test(ultimoTextoAssistant);

      if (preguntaDescripcion || preguntaHora || preguntaFecha) {
        return true;
      }
    }
  }

  // ─── CASO 2: operaciones CRUD y listar (no requieren preguntas previas) ──
  const patronesCRUDyListar = [
    // Listar
    /\bqué tengo agendado\b/i,
    /\bqué recordatorios\b/i,
    /\bmuéstrame los pendientes\b/i,
    /\bque tengo pendiente\b/i,
    /\blistame los recordatorios\b/i,

    // Actualizar / Completar
    /\bcompleta\b.{0,30}\brecordatorio\b/i,
    /\bmarca\b.{0,15}\b(como )?hecho\b/i,
    /\bmarca\b.{0,15}\bcompletado\b/i,
    /\bcambia\b.{0,20}\bhora\b/i,
    /\bmueve\b.{0,30}(al|para|el)\b/i,

    // Eliminar
    /\bborra\b.{0,30}\brecordatorio\b/i,
    /\belimina\b.{0,30}\brecordatorio\b/i,
    /\bsaca\b.{0,30}\brecordatorio\b/i,

    // Reactivar
    /\breactiva\b/i,
    /\breactivar\b/i,
    /\bvuelve a poner pendiente\b/i,
    /\bmarca\b.{0,15}\bno completado\b/i,
  ];

  if (patronesCRUDyListar.some(p => p.test(msgLower))) {
    return true;
  }

  // ─── CASO crear (sin pregunta previa) ────────────────────────────────────
  // Verbos de crear (agenda, recuérdame, etc) SE DETECTAN pero NO fuerzan tool.
  // Niko responderá con auto y preguntará lo que falte. El forzado ocurre en
  // el turno siguiente cuando el usuario responda la pregunta (CASO 1).
  return false;
}

// ─── chatWithNikoStream ────────────────────────────────────────────────────────
//
// Versión streaming de chatWithNiko. En lugar de devolver un objeto,
// emite eventos SSE a medida que Claude genera tokens.
//
// @param {object} params   - { mensaje, historial, empresa_id, user_id }
// @param {Function} emit   - emit(eventName, dataObj) → escribe al SSE stream
//
// Eventos emitidos (en orden):
//   delta      → { texto: string }          — chunk de texto de Claude
//   tool_start → { tool, input }            — Claude quiere usar una tool
//   tool_end   → { ok, mensaje }            — tool ejecutada
//   done       → { respuesta, eerr_ampliado_recien_revelado, meta, saturado }
//   (en saturación: delta con plantilla + done con saturado:true)

async function chatWithNikoStream({ mensaje, historial, empresa_id, user_id }, emit) {
  const inicio    = Date.now();
  const supabase  = getSupabase();

  // ── 1. Cargar datos de la empresa ─────────────────────────────────────────
  const { data, error } = await supabase
    .from('empresas')
    .select('nombre, giro, representante_nombre, representante_rol, tratamiento')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) {
    console.error(`[chatWithNikoStream] Error query empresa ${empresa_id}:`, error.message);
    throw new Error('No se pudieron cargar los datos de la empresa');
  }
  if (!data) {
    console.error(`[chatWithNikoStream] Empresa no encontrada: ${empresa_id}`);
    throw new Error('Empresa no encontrada');
  }

  // ── 2. Mapear datos con fallbacks seguros ─────────────────────────────────
  const nombreEmpresa = data.nombre               || 'tu empresa';
  const rubro         = data.giro                 || 'su rubro';
  const nombreCliente = data.representante_nombre || 'cliente';
  const rolCliente    = data.representante_rol    || 'dueño/a';
  const tratamiento   = data.tratamiento          || 'tu';

  // ── 3. Obtener contexto financiero ────────────────────────────────────────
  let contextoFinanciero = null;
  try {
    contextoFinanciero = await obtenerContextoFinanciero(empresa_id);
  } catch (errCtx) {
    console.error('[chatWithNikoStream] Error cargando contexto financiero:', errCtx.message);
  }

  // ── 4-5. Construir system prompt ──────────────────────────────────────────
  const systemPromptBase = buildSystemPrompt({
    nombreCliente,
    rolCliente,
    nombreEmpresa,
    rubro,
    tratamiento,
  });

  const tieneContexto = contextoFinanciero && (
    contextoFinanciero.resumenes_por_mes?.length > 0        ||
    contextoFinanciero.datos_manuales?.length > 0           ||
    contextoFinanciero.patrones_pendientes?.length > 0      ||
    contextoFinanciero.reglas_activas?.length > 0           ||
    contextoFinanciero.es_primera_sesion === true
  );
  const systemPromptFinal = tieneContexto
    ? systemPromptBase + '\n\n## CONTEXTO FINANCIERO ACTUAL\n\n' + formatearContexto(contextoFinanciero)
    : systemPromptBase;

  const anthropic = new Anthropic();

  let textoRonda1   = '';
  let textoRonda2   = '';
  let finalMsg1     = null;
  let modeloUsado   = MODEL;
  let totalInput    = 0;
  let totalOutput   = 0;
  const toolsUsadas = [];

  // Helper interno: persistir assistant + emitir done, luego retornar
  const persistirYTerminar = ({ respuesta, eerrAmpliado, saturado }) => {
    const tokens_usados = totalInput + totalOutput;
    const latencia_ms   = Date.now() - inicio;

    emit('done', {
      respuesta,
      eerr_ampliado_recien_revelado: eerrAmpliado,
      meta: { modelo_usado: modeloUsado, tokens_usados, tools_usadas: toolsUsadas },
      saturado,
    });

    // Fire-and-forget: persistir respuesta del assistant
    supabase.from('niko_conversaciones').insert({
      empresa_id,
      user_id,
      rol:             'assistant',
      mensaje:         respuesta,
      tools_invocadas: toolsUsadas,
      tokens_usados,
      modelo_usado:    modeloUsado,
      latencia_ms,
    }).then(({ error: e }) => {
      if (e) console.error('[chatWithNikoStream] Error persistiendo assistant:', e.message);
    });
  };

  // ── 6. RONDA 1: stream con tools ─────────────────────────────────────────
  const intencionRecordatorio_Stream = detectarIntencionRecordatorio(mensaje, historial);
  console.log('[chatWithNikoStream] intencionRecordatorio:', intencionRecordatorio_Stream, '| tool_choice:', intencionRecordatorio_Stream ? 'any' : 'auto');

  try {
    const stream1 = anthropic.messages.stream({
      model:      MODEL,
      max_tokens: 2000,
      system:     [{ type: 'text', text: systemPromptFinal, cache_control: { type: 'ephemeral' } }],
      tools:      NIKO_TOOLS,
      ...(intencionRecordatorio_Stream && { tool_choice: { type: 'any' } }),
      messages:   [
        ...(historial || []),
        { role: 'user', content: mensaje },
      ],
    });

    for await (const event of stream1) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        textoRonda1 += chunk; // buffered — se emite tras validación del supervisor
      }
    }

    // finalMessage() ensamblada por el SDK: incluye tool_use con input completo
    finalMsg1    = await stream1.finalMessage();
    modeloUsado  = finalMsg1.model || MODEL;
    totalInput  += finalMsg1.usage?.input_tokens  || 0;
    totalOutput += finalMsg1.usage?.output_tokens || 0;

    console.log('[chatWithNikoStream] Ronda 1 completa. stop_reason:', finalMsg1.stop_reason,
      '| tokens ronda 1:', (finalMsg1.usage?.input_tokens || 0) + (finalMsg1.usage?.output_tokens || 0));
    console.log('[chatWithNikoStream] Cache R1:', {
      cache_creation: finalMsg1.usage?.cache_creation_input_tokens || 0,
      cache_read:     finalMsg1.usage?.cache_read_input_tokens     || 0,
      input_normal:   finalMsg1.usage?.input_tokens                || 0,
      output:         finalMsg1.usage?.output_tokens               || 0,
    });

  } catch (err) {
    if (esErrorSaturacion(err)) {
      console.warn(`[chatWithNikoStream] Saturación ronda 1 (${err.status}).`);
      const textoSat = mensajeSaturacionAleatorio();
      toolsUsadas.push('_saturacion');
      emit('delta', { texto: textoSat });
      persistirYTerminar({ respuesta: textoSat, eerrAmpliado: false, saturado: true });
      return;
    }
    throw err;
  }

  // ── 6b. SUPERVISOR ANTI-ALUCINACIÓN ──────────────────────────────────────
  // Si Claude terminó con end_turn pero el texto suena como si hubiera
  // ejecutado una tool, verificamos en BD. Si la BD no refleja el cambio,
  // reintentamos con tool_choice: any para forzar la tool real.
  // El supervisor va ANTES del bloque tool_use para que, si el retry
  // retorna tool_use, el bloque de abajo lo procese normalmente.
  if (finalMsg1.stop_reason === 'end_turn') {
    const sospecha = detectarAccionConsumada(textoRonda1, historial || []);

    if (sospecha) {
      console.log('[supervisor] Posible alucinación detectada:', sospecha);
      const accionReal = await verificarAccionEnBD(empresa_id, sospecha.accion, sospecha.titulo);

      if (!accionReal) {
        console.log('[supervisor] BD desmiente a Niko. Reintentando con tool_choice: any');
        toolsUsadas.push('_supervisor_retry');

        try {
          const stream1Retry = anthropic.messages.stream({
            model:      MODEL,
            max_tokens: 2000,
            system:     [{ type: 'text', text: systemPromptFinal, cache_control: { type: 'ephemeral' } }],
            tools:      NIKO_TOOLS,
            tool_choice: { type: 'any' },
            messages:   [
              ...(historial || []),
              { role: 'user', content: mensaje },
            ],
          });

          // Consumir el stream sin re-emitir (ya se emitió el texto de ronda 1)
          for await (const _event of stream1Retry) { /* vacío intencional */ }

          const finalMsg1Retry = await stream1Retry.finalMessage();
          totalInput  += finalMsg1Retry.usage?.input_tokens  || 0;
          totalOutput += finalMsg1Retry.usage?.output_tokens || 0;
          console.log('[supervisor] Retry stop_reason:', finalMsg1Retry.stop_reason);

          if (finalMsg1Retry.stop_reason === 'tool_use') {
            // Buffer descartado (textoRonda1 = '') — ronda 2 emitirá la respuesta real
            finalMsg1 = finalMsg1Retry;
            textoRonda1 = ''; // descartar buffer: el if(textoRonda1) posterior no emitirá nada
          } else {
            console.log('[supervisor] Retry tampoco llamó tool. Devolviendo mensaje amigable.');
            const mensajeAmigable = 'Disculpa, se me trabó algo procesando eso. ¿Puedes intentar de nuevo?';
            emit('delta', { texto: mensajeAmigable });
            persistirYTerminar({ respuesta: mensajeAmigable, eerrAmpliado: false, saturado: false });
            return;
          }
        } catch (retryErr) {
          console.error('[supervisor] Error en retry:', retryErr.message);
          // Degradación graceful: dejar pasar la respuesta original
        }
      } else {
        console.log('[supervisor] BD confirma la acción. Niko no alucinó.');
      }
    }
  }

  // Emitir buffer de ronda 1 SOLO si no se va a llamar tool en Ronda 2.
  // Si hay tool_use, el texto pre-tool es un "borrador" que Ronda 2 regenera.
  // Esto evita doble render (Bug 1) y también filtra verbalizaciones de
  // proceso interno (Bug 2). Documentado en diseño multi-agente Check 2.
  if (textoRonda1 && finalMsg1.stop_reason !== 'tool_use') {
    emit('delta', { texto: textoRonda1 });
  }

  // ── 7. Tool calling si Claude lo pidió ───────────────────────────────────
  if (finalMsg1.stop_reason === 'tool_use') {
    // El SDK ensambla el bloque tool_use completo (con input parseado) en finalMessage()
    const toolUseBlock = finalMsg1.content.find(b => b.type === 'tool_use');

    if (toolUseBlock) {
      console.log('[chatWithNikoStream] Claude pidió tool:', toolUseBlock.name, '| id:', toolUseBlock.id);
      toolsUsadas.push(toolUseBlock.name);

      emit('tool_start', { tool: toolUseBlock.name, input: toolUseBlock.input });

      const toolResult = await ejecutarTool(toolUseBlock, empresa_id, user_id);

      emit('tool_end', { ok: toolResult.ok, mensaje: toolResult.mensaje });

      // ── RONDA 2: stream sin tools, con tool_result ────────────────────────
      try {
        const stream2 = anthropic.messages.stream({
          model:      MODEL,
          max_tokens: 2000,
          system:     [{ type: 'text', text: systemPromptFinal, cache_control: { type: 'ephemeral' } }],
          messages:   [
            ...(historial || []),
            { role: 'user',      content: mensaje },
            { role: 'assistant', content: finalMsg1.content },  // content completo de ronda 1
            {
              role:    'user',
              content: [
                {
                  type:        'tool_result',
                  tool_use_id: toolUseBlock.id,
                  content:     toolResult.ok
                    ? JSON.stringify({
                        mensaje: toolResult.mensaje,
                        ...(toolResult.datos   !== undefined && { datos:   toolResult.datos   }),
                        ...(toolResult.choques !== undefined && { choques: toolResult.choques }),
                      })
                    : `Error: ${toolResult.mensaje}`,
                },
              ],
            },
          ],
          // Sin tools: evita loops
        });

        for await (const event of stream2) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            textoRonda2 += chunk;
            emit('delta', { texto: chunk });
          }
        }

        const finalMsg2  = await stream2.finalMessage();
        modeloUsado  = finalMsg2.model || modeloUsado;
        totalInput  += finalMsg2.usage?.input_tokens  || 0;
        totalOutput += finalMsg2.usage?.output_tokens || 0;

        console.log('[chatWithNikoStream] Ronda 2 completa. tokens acumulados:', totalInput + totalOutput);
        console.log('[chatWithNikoStream] Cache R2:', {
          cache_creation: finalMsg2.usage?.cache_creation_input_tokens || 0,
          cache_read:     finalMsg2.usage?.cache_read_input_tokens     || 0,
          input_normal:   finalMsg2.usage?.input_tokens                || 0,
          output:         finalMsg2.usage?.output_tokens               || 0,
        });

      } catch (err) {
        if (esErrorSaturacion(err)) {
          console.warn(`[chatWithNikoStream] Saturación ronda 2 (${err.status}).`);
          const textoSat = mensajeSaturacionAleatorio();
          toolsUsadas.push('_saturacion');
          emit('delta', { texto: textoSat });
          textoRonda2 = textoSat;
          const respSat = (textoRonda1 + textoRonda2).trim();
          persistirYTerminar({ respuesta: respSat, eerrAmpliado: false, saturado: true });
          return;
        }
        throw err;
      }
    }
  }

  // ── 8. Marcar primera sesión completada si corresponde ───────────────────
  if (contextoFinanciero?.es_primera_sesion === true) {
    const { error: updateError } = await supabase
      .from('empresas')
      .update({ primera_conversacion_niko_completada: true })
      .eq('id', empresa_id)
      .eq('primera_conversacion_niko_completada', false);

    if (updateError) {
      console.warn('[chatWithNikoStream] No se pudo marcar primera sesión completada:', updateError.message);
    } else {
      console.log('[chatWithNikoStream] Primera sesión marcada como completada para empresa:', empresa_id);
    }
  }

  // ── 9. Verificar flag EERR Ampliado ──────────────────────────────────────
  let eerrAmpliado = false;
  const { data: empresaFlags } = await supabase
    .from('empresas')
    .select('eerr_ampliado_revelado, eerr_ampliado_niko_notificado')
    .eq('id', empresa_id)
    .single();

  if (empresaFlags?.eerr_ampliado_revelado && !empresaFlags?.eerr_ampliado_niko_notificado) {
    await supabase
      .from('empresas')
      .update({ eerr_ampliado_niko_notificado: true })
      .eq('id', empresa_id);
    eerrAmpliado = true;
  }

  // ── 10. Armar respuesta completa y emitir done ───────────────────────────
  let respuestaCompleta = (textoRonda1 + textoRonda2).trim();

  if (!respuestaCompleta) {
    console.warn('[chatWithNikoStream] Respuesta vacía de Claude, usando fallback');
    const fallback = 'Disculpa, hubo un problema. ¿Puedes repetir tu pregunta?';
    emit('delta', { texto: fallback });
    respuestaCompleta = fallback;
  }

  persistirYTerminar({ respuesta: respuestaCompleta, eerrAmpliado, saturado: false });
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

module.exports = { chatWithNikoStream };
