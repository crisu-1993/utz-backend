'use strict';

// ─── Validaciones programáticas multi-agente ─────────────────────────────────
//
// 4 checks que se aplican a outputs de los agentes Niko.
// Diseño documentado en Fase A, sección A.4.
//
// Exports:
//   verificarToolEjecutada  — Check 1: ¿se llamó la tool correcta?
//   verificarDobleRespuesta — Check 2: ¿hay texto R1 que no debe emitirse?
//   verificarVerbalizacion  — Check 3: ¿el texto expone proceso interno?
//   verificarBD             — Check 4: ¿Supabase confirma el cambio?

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Lista negra de verbalización (27 patrones) ───────────────────────────────
//
// Frases que nunca deben aparecer en la respuesta al usuario porque
// revelan el proceso interno del agente.

const PATRONES_VERBALIZACION = [
  // Originales del monolítico (15)
  /voy\s+a\s+(verificar|revisar|consultar|buscar)/i,
  /d[eé]jame\s+(revisar|consultar|buscar|verificar)/i,
  /espera[,]?\s+un\s+momento/i,
  /un\s+momento[,]?\s+(por\s+favor|mientras)/i,
  /\bprocesando\b/i,
  /llamando\s+a\s+la\s+(tool|funci[oó]n|herramienta)/i,
  /\bejecutando\b/i,
  /voy\s+a\s+(ejecutar|llamar|invocar)/i,
  /\bleyendo\s+el\s+marcador\b/i,
  /\bextrayendo\s+el\s+(id|uuid)\b/i,
  /consultando\s+(la\s+)?(base\s+de\s+datos|bd)/i,
  /verificando\s+en\s+(la\s+)?(base|bd)/i,
  /buscando\s+en\s+(mis\s+)?(registros|datos|notas)/i,
  /accediendo\s+a\s+/i,
  /recuperando\s+(la\s+)?informaci[oó]n/i,
  // Nuevas (12) — detectadas como escapes de Bug 2
  /espera[,]?\s+no\s+tengo\s+el\s+id/i,
  /necesito\s+buscar(lo)?\s+primero/i,
  /no\s+tengo\s+el\s+(uuid|id)\s+(real|del)/i,
  /primero\s+(voy\s+a\s+)?buscar/i,
  /\bprocesando\b.{0,20}\bsolicitud\b/i,
  /analizando\s+(tu\s+)?(solicitud|mensaje|pregunta)/i,
  /interpretando\s+/i,
  /tu\s+pregunta\s+(es|implica)/i,
  /entiendo\s+que\s+quieres\s+que\s+busque/i,
  /antes\s+de\s+responder[,]?\s+/i,
  /para\s+darte\s+esta\s+respuesta/i,
  /generando\s+respuesta/i,
  // ── Gap 1: "permíteme [verbo]" ──
  /perm[ií]teme\s+(consultar|revisar|verificar|buscar|chequear)/i,
  // ── Gap 2: "consultando [algo del sistema]" sin "la base" ──
  /\bconsultando\b/i,
  // ── Gap 3: "llamo a [tool]" ──
  /\bllamo\s+a\s+(listar|buscar|crear|verificar|consultar|actualizar|eliminar)/i,
  // ── Gap 4: "voy a llamar" (variante sin complemento) ──
  /voy\s+a\s+llamar/i,
  // ── Gap 5: "estoy [gerundio interno]" ──
  /estoy\s+(consultando|buscando|revisando|verificando|procesando|chequeando)/i,
];

// ─── Patrones de promesa de acción (20 patrones) ─────────────────────────────
//
// Texto que afirma haber ejecutado una acción. Si aparece en una respuesta
// donde NO se llamó la tool correspondiente → alucinación detectada.

const PATRONES_PROMESA_ACCION = [
  // "Listo, + verbo"
  /listo[,]?\s+marqu[eé]/i,
  /listo[,]?\s+complet[eé]/i,
  /listo[,]?\s+elimin[eé]/i,
  /listo[,]?\s+borr[eé]/i,
  /listo[,]?\s+agend[eé]/i,
  /listo[,]?\s+actualic[eé]/i,
  /listo[,]?\s+reactiv[eé]/i,
  // "Hecho, + verbo"
  /hecho[,]?\s+marqu[eé]/i,
  /hecho[,]?\s+elimin[eé]/i,
  /hecho[,]?\s+actualic[eé]/i,
  /hecho[,]?\s+reactiv[eé]/i,
  /hecho[,]?\s+[^.]{0,30}\s+queda\s+(completado|marcado)/i,
  // "quedó + estado"
  /qued[oó]\s+(agendado|marcado|completado|eliminado)/i,
  /qued[oó]\s+(marcad|completad|eliminad)/i,
  /ya\s+qued[oó]\s+/i,
  // "Marqué/Eliminé/etc. al inicio de oración"
  /^marqu[eé]\s+/i,
  /^borrado\b/i,
  /^elimin[eé]\b/i,
  /^complet[eé]\b/i,
  // Otras variantes
  /perfecto[,]?\s+qued[oó]/i,
  /ya\s+lo\s+(marqu[eé]|borr[eé]|elimin[eé])/i,
  /reactiv[eé]\s+[^.]+\s+como\s+pendiente/i,
  // ── Gap A: pronombres intercalados "Listo, lo marqué" ──
  /listo[,]?\s+(?:lo|la|los|las|te|me|se|ya)\s+(marqu[eé]|complet[eé]|elimin[eé]|borr[eé]|agend[eé]|actualic[eé]|reactiv[eé])/i,
  // ── Gap B: participios después de "Listo," ──
  /listo[,]?\s+(agendado|marcado|completado|eliminado|borrado|actualizado|reactivado)/i,
  // ── Gap C: "X quedó/está [participio]" ──
  /\b(?:qued[oó]|est[aá])\s+(agendado|marcado|completado|eliminado|borrado|actualizado|reactivado)\b/i,
];

// ─── Mapa accion → tool requerida ────────────────────────────────────────────

const TOOL_POR_ACCION = {
  crear:      'crear_recordatorio',
  actualizar: 'actualizar_recordatorio',
  completar:  'actualizar_recordatorio',
  editar:     'actualizar_recordatorio',
  reactivar:  'actualizar_recordatorio',
  eliminar:   'eliminar_recordatorio',
  listar:     'listar_recordatorios',
};

// ── Check 1: verificarToolEjecutada ───────────────────────────────────────────

/**
 * Verifica si la tool correcta fue llamada, detectando alucinaciones
 * cuando el texto afirma éxito pero no hay tool call registrada.
 *
 * @param {string[]} toolsUsadas     - Tools efectivamente llamadas en el turno
 * @param {string}   accionEsperada  - 'crear'|'actualizar'|'completar'|'editar'|
 *                                     'reactivar'|'eliminar'|'listar'
 * @param {string}   texto           - Texto emitido por el agente
 * @returns {{ ok: boolean, motivo: string|null, tipo: string|null }}
 */
function verificarToolEjecutada(toolsUsadas, accionEsperada, texto) {
  const toolRequerida = TOOL_POR_ACCION[accionEsperada];

  if (!toolRequerida) {
    // Acción no requiere tool (ej: conversación) → ok por defecto
    return { ok: true, motivo: null, tipo: null };
  }

  const toolLlamada = Array.isArray(toolsUsadas) &&
    toolsUsadas.includes(toolRequerida);

  if (toolLlamada) {
    return { ok: true, motivo: null, tipo: null };
  }

  // Tool no llamada — buscar si el texto afirma haber actuado
  const textoLimpio = typeof texto === 'string' ? texto : '';
  const hayPromesa  = PATRONES_PROMESA_ACCION.some(re => re.test(textoLimpio));

  if (hayPromesa) {
    return {
      ok:    false,
      motivo: `Tool '${toolRequerida}' no llamada pero el texto afirma éxito.`,
      tipo:  'hallucination_suspected',
    };
  }

  // Tool no llamada pero tampoco hay promesa de acción → flujo incompleto
  // (ej: agente pidió confirmación en vez de ejecutar)
  return {
    ok:    true,   // no es alucinación, es flujo esperado
    motivo: null,
    tipo:  null,
  };
}

// ── Check 2: verificarDobleRespuesta ──────────────────────────────────────────

/**
 * Determina si el buffer de Ronda 1 debe emitirse al usuario.
 * Si stop_reason='tool_use', el texto R1 es un borrador que Ronda 2 regenera.
 * Esto previene el doble render (Bug 1) y filtra verbalizaciones pre-tool (Bug 2).
 *
 * @param {string} textoRonda1  - Texto acumulado en Ronda 1
 * @param {string} stopReason   - 'tool_use' | 'end_turn' | 'max_tokens'
 * @returns {{ emitir: boolean, razon: string }}
 */
function verificarDobleRespuesta(textoRonda1, stopReason) {
  if (!textoRonda1 || textoRonda1.trim() === '') {
    return { emitir: false, razon: 'textoRonda1_vacio' };
  }
  if (stopReason === 'tool_use') {
    return { emitir: false, razon: 'borrador_pre_tool' };
  }
  return { emitir: true, razon: 'respuesta_final_r1' };
}

// ── Check 3: verificarVerbalizacion ───────────────────────────────────────────

/**
 * Detecta si el texto expone proceso interno del agente.
 * Los 27 patrones cubren verbalizaciones de búsqueda, invocación de tools,
 * y frases de "espera" documentadas en Bug 2.
 *
 * @param {string} texto - Texto a verificar
 * @returns {{ limpio: boolean, fraseDetectada: string|null }}
 */
function verificarVerbalizacion(texto) {
  if (!texto || typeof texto !== 'string') {
    return { limpio: true, fraseDetectada: null };
  }

  for (const patron of PATRONES_VERBALIZACION) {
    const match = patron.exec(texto);
    if (match) {
      return { limpio: false, fraseDetectada: match[0] };
    }
  }

  return { limpio: true, fraseDetectada: null };
}

// ── Check 4: verificarBD ──────────────────────────────────────────────────────

/**
 * Verifica en Supabase si la acción efectivamente ocurrió en los últimos 10s.
 * Fail-open: si hay timeout o error de conexión → asume OK.
 *
 * @param {string} empresaId  - UUID de la empresa
 * @param {string} accion     - 'completar'|'eliminar'|'editar'|'reactivar'|'crear'
 * @param {string} titulo     - Título del recordatorio (búsqueda fuzzy)
 * @returns {Promise<{ confirmadoEnBD: boolean, error: string|null }>}
 */
async function verificarBD(empresaId, accion, titulo) {
  if (!empresaId || !titulo) {
    return { confirmadoEnBD: false, error: 'Faltan parámetros' };
  }

  const supabase = getSupabase();
  const haceDiezSegundos = new Date(Date.now() - 10_000).toISOString();
  const tituloBusqueda   = `%${titulo.trim()}%`;

  // Timeout de 10s usando Promise.race
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ confirmadoEnBD: true, error: 'timeout_fail_open' }), 10_000)
  );

  const verificacion = (async () => {
    try {
      if (accion === 'completar') {
        const { data } = await supabase
          .from('recordatorios')
          .select('id')
          .eq('empresa_id', empresaId)
          .ilike('titulo', tituloBusqueda)
          .eq('completado', true)
          .gte('updated_at', haceDiezSegundos)
          .limit(1);
        return { confirmadoEnBD: Array.isArray(data) && data.length > 0, error: null };
      }

      if (accion === 'reactivar') {
        const { data } = await supabase
          .from('recordatorios')
          .select('id')
          .eq('empresa_id', empresaId)
          .ilike('titulo', tituloBusqueda)
          .eq('completado', false)
          .gte('updated_at', haceDiezSegundos)
          .limit(1);
        return { confirmadoEnBD: Array.isArray(data) && data.length > 0, error: null };
      }

      if (accion === 'eliminar') {
        // Verificación positiva: el registro ya no existe (o tiene deleted_at)
        const { data } = await supabase
          .from('recordatorios')
          .select('id')
          .eq('empresa_id', empresaId)
          .ilike('titulo', tituloBusqueda)
          .limit(1);
        // Si no aparece → fue eliminado
        return { confirmadoEnBD: !Array.isArray(data) || data.length === 0, error: null };
      }

      if (accion === 'editar' || accion === 'actualizar') {
        const { data } = await supabase
          .from('recordatorios')
          .select('id')
          .eq('empresa_id', empresaId)
          .ilike('titulo', tituloBusqueda)
          .gte('updated_at', haceDiezSegundos)
          .limit(1);
        return { confirmadoEnBD: Array.isArray(data) && data.length > 0, error: null };
      }

      if (accion === 'crear') {
        const { data } = await supabase
          .from('recordatorios')
          .select('id')
          .eq('empresa_id', empresaId)
          .ilike('titulo', tituloBusqueda)
          .gte('created_at', haceDiezSegundos)
          .limit(1);
        return { confirmadoEnBD: Array.isArray(data) && data.length > 0, error: null };
      }

      return { confirmadoEnBD: true, error: `accion_desconocida:${accion}` };

    } catch (err) {
      console.error('[validador] verificarBD error:', err.message);
      return { confirmadoEnBD: true, error: err.message }; // fail-open
    }
  })();

  return Promise.race([verificacion, timeout]);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  verificarToolEjecutada,
  verificarDobleRespuesta,
  verificarVerbalizacion,
  verificarBD,
  // Exportar listas para que Niko-Madre pueda usar en su prompt de supervisión
  PATRONES_VERBALIZACION,
  PATRONES_PROMESA_ACCION,
};
