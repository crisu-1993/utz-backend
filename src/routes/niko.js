'use strict';

// ─── Rutas /api/niko ──────────────────────────────────────────────────────────
//
// Endpoints:
//   POST /api/niko/chat → envía un mensaje a Niko y recibe su respuesta
//
// Body:
//   { mensaje: string, historial?: Array<{ role: 'user'|'assistant', content: string }> }

const express                    = require('express');
const { createClient }           = require('@supabase/supabase-js');
const { authMiddleware }         = require('../middleware/auth');
const { chatWithNiko }           = require('../services/niko/nikoService');
const { detectarDiagnostico }    = require('./categorias');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const router = express.Router();

const MAX_HISTORIAL = 50;
const ROLES_VALIDOS = new Set(['user', 'assistant']);

// ═══════════════════════════════════════════════════════════════
// PLANTILLAS DE RECORDATORIOS PROACTIVOS DE NIKO
// Regla anti-pesadez: máximo 3 recordatorios escalados por tema.
// ═══════════════════════════════════════════════════════════════

const HORAS_ENTRE_RECORDATORIOS       = 48;
const DIAS_RESET_TRAS_R3              = 7;
const TIPO_RECORDATORIO_PENDIENTES    = 'pendientes_categorizacion';

function plantillaRecordatorio(numero, datos) {
  const { nombre_usuario, total, ingresos, egresos } = datos;
  const saludo_r1 = nombre_usuario ? `Hola ${nombre_usuario}` : 'Jefe';

  switch (numero) {
    case 1:
      return `${saludo_r1}. Vi que tienes ${total} transacciones sin categorizar (${ingresos} ingresos y ${egresos} egresos). ¿Las vemos ahora?`;
    case 2:
      return `Jefe, sigo viendo las ${total} pendientes desde hace un par de días. ¿Las trabajamos? Cuanto antes las categoricemos, mejor te puedo armar el EERR.`;
    case 3:
      return `Jefe, no le puedo volver a recordar. Tenemos que seguir avanzando con la pega. Cuando quieras retomar las ${total} pendientes, avísame.`;
    default:
      throw new Error(`[niko] Número de recordatorio inválido: ${numero}`);
  }
}

// ─── POST /api/niko/chat ──────────────────────────────────────────────────────
// Body: { mensaje: string, historial?: Array }
// Requiere: Authorization: Bearer <token>
router.post('/chat', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { mensaje, historial: rawHistorial } = req.body || {};

  // Validar mensaje
  if (!mensaje || !String(mensaje).trim()) {
    return res.status(400).json({
      ok:    false,
      error: 'El campo "mensaje" es requerido y no puede estar vacío',
    });
  }

  // Validar y normalizar historial
  let historial = [];

  if (rawHistorial !== undefined) {
    if (!Array.isArray(rawHistorial)) {
      return res.status(400).json({
        ok:    false,
        error: 'El campo "historial" debe ser un array',
      });
    }

    if (rawHistorial.length > MAX_HISTORIAL) {
      return res.status(400).json({
        ok:    false,
        error: `El historial no puede superar ${MAX_HISTORIAL} mensajes`,
      });
    }

    for (let i = 0; i < rawHistorial.length; i++) {
      const item = rawHistorial[i];
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ ok: false, error: `historial[${i}] debe ser un objeto` });
      }
      if (!ROLES_VALIDOS.has(item.role)) {
        return res.status(400).json({ ok: false, error: `historial[${i}].role debe ser 'user' o 'assistant'` });
      }
      if (typeof item.content !== 'string' || !item.content.trim()) {
        return res.status(400).json({ ok: false, error: `historial[${i}].content debe ser un string no vacío` });
      }
    }

    historial = rawHistorial.map(item => ({
      role:    item.role,
      content: String(item.content),
    }));
  }

  try {
    const { respuesta, modelo_usado, tokens_usados } = await chatWithNiko(
      empresa_id,
      String(mensaje).trim(),
      historial,
      user_id
    );

    // ── Verificar si Niko debe notificar EERR Ampliado ──
    let eerrAmpliado = false;

    const { data: empresaFlags } = await supabase
      .from('empresas')
      .select('eerr_ampliado_revelado, eerr_ampliado_niko_notificado')
      .eq('id', empresa_id)
      .single();

    if (
      empresaFlags?.eerr_ampliado_revelado &&
      !empresaFlags?.eerr_ampliado_niko_notificado
    ) {
      await supabase
        .from('empresas')
        .update({ eerr_ampliado_niko_notificado: true })
        .eq('id', empresa_id);

      eerrAmpliado = true;
    }

    return res.json({
      ok: true,
      respuesta,
      eerr_ampliado_recien_revelado: eerrAmpliado,
      meta: { modelo_usado, tokens_usados },
    });

  } catch (err) {
    console.error('[niko] Error en POST /chat:', err.message);
    return res.status(500).json({
      ok:    false,
      error: err.message || 'Error interno al procesar el mensaje',
    });
  }
});

// ─── GET /api/niko/verificar-recordatorio/:empresa_id ────────────────────────
//
// Verifica si Niko debe enviar un recordatorio proactivo a la empresa.
// Si corresponde, lo crea en niko_recordatorios y devuelve el mensaje.
// Aplica regla anti-pesadez (máximo 3 recordatorios escalados).

router.get('/verificar-recordatorio/:empresa_id', authMiddleware, async (req, res) => {
  const { user_id }  = req.auth;
  const empresa_id   = req.params.empresa_id;

  try {
    // 1) Ownership check
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', empresa_id)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[verificar-recordatorio] Error validando empresa:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre esa empresa' });
    }

    // ──────────────────────────────────────────────────────────────
    // NUEVO: Primero verificar si hay recordatorios sin leer en BD.
    // Si existen, devolver el más reciente y auto-marcar los antiguos.
    // Esto garantiza que un recordatorio creado siga visible aunque el
    // usuario recargue la página, hasta que él lo marque como leído.
    // ──────────────────────────────────────────────────────────────

    const { data: noLeidos, error: noLeidosErr } = await supabase
      .from('niko_recordatorios')
      .select('id, payload, created_at')
      .eq('empresa_id', empresa_id)
      .eq('tipo', TIPO_RECORDATORIO_PENDIENTES)
      .eq('leido', false)
      .order('created_at', { ascending: false });

    if (noLeidosErr) {
      console.error('[verificar-recordatorio] Error consultando no leídos:', noLeidosErr.message);
      return res.status(500).json({ ok: false, error: 'Error consultando recordatorios sin leer' });
    }

    if (noLeidos && noLeidos.length > 0) {
      const masReciente = noLeidos[0];

      // Si hay 2+ sin leer, auto-marcar los antiguos como leídos
      if (noLeidos.length > 1) {
        const idsAntiguos = noLeidos.slice(1).map((r) => r.id);
        const { error: marcarErr } = await supabase
          .from('niko_recordatorios')
          .update({ leido: true, read_at: new Date().toISOString() })
          .in('id', idsAntiguos);

        if (marcarErr) {
          // No bloqueamos el flujo si falla la limpieza, solo logueamos.
          console.error('[verificar-recordatorio] Error auto-marcando antiguos:', marcarErr.message);
        } else {
          console.log(`[verificar-recordatorio] Auto-marcados ${idsAntiguos.length} recordatorio(s) antiguo(s) como leídos.`);
        }
      }

      // Devolver el más reciente reutilizando el mensaje del payload guardado.
      const numero = masReciente.payload?.numero_recordatorio ?? 1;
      const mensaje = masReciente.payload?.mensaje ?? '';

      return res.json({
        ok:                  true,
        debe_enviar:         true,
        numero_recordatorio: numero,
        mensaje,
        recordatorio_id:     masReciente.id,
      });
    }

    // ──────────────────────────────────────────────────────────────
    // Si no hay sin leer, continúa con la lógica actual de cadencia.
    // ──────────────────────────────────────────────────────────────

    // 2) Detectar estado actual de pendientes
    const diagnostico          = await detectarDiagnostico(supabase, empresa_id);
    const sin_categorizar_total = diagnostico.sin_categorizar.total;
    const incoherentes_total    = diagnostico.incoherentes.length;

    // Si no hay pendientes, no enviar nada
    if (sin_categorizar_total === 0 && incoherentes_total === 0) {
      return res.json({
        ok:                  true,
        debe_enviar:         false,
        numero_recordatorio: null,
        mensaje:             null,
        recordatorio_id:     null,
      });
    }

    // 3) Consultar último recordatorio del mismo tipo
    const { data: ultimoRecordatorio, error: ultimoErr } = await supabase
      .from('niko_recordatorios')
      .select('id, payload, created_at')
      .eq('empresa_id', empresa_id)
      .eq('tipo', TIPO_RECORDATORIO_PENDIENTES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimoErr) {
      console.error('[verificar-recordatorio] Error consultando último recordatorio:', ultimoErr.message);
      return res.status(500).json({ ok: false, error: 'Error consultando historial' });
    }

    // 4) Decidir qué número de recordatorio toca (lógica de cadencia)
    let siguienteNumero = null;

    if (!ultimoRecordatorio) {
      // Nunca se envió uno → empezar por R1
      siguienteNumero = 1;
    } else {
      const ultimoNumero       = ultimoRecordatorio.payload?.numero_recordatorio;
      const snapshotAnterior   = ultimoRecordatorio.payload?.sin_categorizar_total;
      const horasDesdeUltimo   = (Date.now() - new Date(ultimoRecordatorio.created_at).getTime()) / (1000 * 60 * 60);
      const diasDesdeUltimo    = horasDesdeUltimo / 24;

      // Detectar si el usuario categorizó algo (snapshot bajó)
      const categorizoAlgo = typeof snapshotAnterior === 'number' && sin_categorizar_total < snapshotAnterior;

      if (categorizoAlgo) {
        // Reset: usuario hizo trabajo → volver a R1
        siguienteNumero = 1;
      } else if (ultimoNumero === 3) {
        // Está en silencio post-R3. Reset solo tras 7 días.
        if (diasDesdeUltimo >= DIAS_RESET_TRAS_R3) {
          siguienteNumero = 1;
        } else {
          siguienteNumero = null; // Silencio.
        }
      } else if (ultimoNumero === 1 || ultimoNumero === 2) {
        // Escalada: pasaron ≥48h sin actividad → siguiente número
        if (horasDesdeUltimo >= HORAS_ENTRE_RECORDATORIOS) {
          siguienteNumero = ultimoNumero + 1;
        } else {
          siguienteNumero = null; // Aún no toca.
        }
      } else {
        // Caso defensivo: numero inválido en payload → empezar de cero
        console.warn('[verificar-recordatorio] numero_recordatorio inválido en payload:', ultimoNumero);
        siguienteNumero = 1;
      }
    }

    if (siguienteNumero === null) {
      return res.json({
        ok:                  true,
        debe_enviar:         false,
        numero_recordatorio: null,
        mensaje:             null,
        recordatorio_id:     null,
      });
    }

    // 5) Obtener nombre del usuario para la plantilla
    let nombre_usuario = null;
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(user_id);
    if (!userErr && userData?.user?.user_metadata?.first_name) {
      nombre_usuario = userData.user.user_metadata.first_name;
    }

    // 6) Generar mensaje
    const mensaje = plantillaRecordatorio(siguienteNumero, {
      nombre_usuario,
      total:    sin_categorizar_total,
      ingresos: diagnostico.sin_categorizar.ingresos,
      egresos:  diagnostico.sin_categorizar.egresos,
    });

    // 7) Insertar el recordatorio en BD
    const payload = {
      numero_recordatorio:      siguienteNumero,
      sin_categorizar_total,
      incoherentes_total,
      ingresos_sin_categorizar: diagnostico.sin_categorizar.ingresos,
      egresos_sin_categorizar:  diagnostico.sin_categorizar.egresos,
      mensaje,
    };

    const { data: nuevoRecordatorio, error: insertErr } = await supabase
      .from('niko_recordatorios')
      .insert({
        empresa_id,
        tipo:  TIPO_RECORDATORIO_PENDIENTES,
        payload,
        leido: false,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[verificar-recordatorio] Error insertando recordatorio:', insertErr.message);
      return res.status(500).json({ ok: false, error: 'Error al crear recordatorio' });
    }

    return res.json({
      ok:                  true,
      debe_enviar:         true,
      numero_recordatorio: siguienteNumero,
      mensaje,
      recordatorio_id:     nuevoRecordatorio.id,
    });

  } catch (err) {
    console.error('[verificar-recordatorio] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ─── POST /api/niko/recordatorios/:id/marcar-leido ───────────────────────────
//
// Marca un recordatorio como leído. Se llama desde el frontend cuando
// el usuario abre el chat de Niko (o hace click en el badge).

router.post('/recordatorios/:id/marcar-leido', authMiddleware, async (req, res) => {
  const { user_id }      = req.auth;
  const recordatorio_id  = req.params.id;

  try {
    // 1) Obtener el recordatorio + su empresa_id
    const { data: recordatorio, error: recErr } = await supabase
      .from('niko_recordatorios')
      .select('id, empresa_id, leido')
      .eq('id', recordatorio_id)
      .maybeSingle();

    if (recErr) {
      console.error('[marcar-leido] Error consultando recordatorio:', recErr.message);
      return res.status(500).json({ ok: false, error: 'Error consultando recordatorio' });
    }
    if (!recordatorio) {
      return res.status(404).json({ ok: false, error: 'Recordatorio no encontrado' });
    }

    // 2) Ownership check vía empresa
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', recordatorio.empresa_id)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[marcar-leido] Error validando ownership:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error validando permisos' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre ese recordatorio' });
    }

    // 3) Si ya estaba leído, devolver OK idempotente
    if (recordatorio.leido) {
      return res.json({ ok: true, ya_estaba_leido: true });
    }

    // 4) Marcar como leído
    const { error: updateErr } = await supabase
      .from('niko_recordatorios')
      .update({ leido: true, read_at: new Date().toISOString() })
      .eq('id', recordatorio_id);

    if (updateErr) {
      console.error('[marcar-leido] Error marcando leído:', updateErr.message);
      return res.status(500).json({ ok: false, error: 'Error al marcar como leído' });
    }

    return res.json({ ok: true, ya_estaba_leido: false });

  } catch (err) {
    console.error('[marcar-leido] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ─── GET /api/niko/recordatorios/:empresa_id ─────────────────────────────────
//
// Lista los recordatorios de Niko de una empresa.
// Query params opcionales:
//   ?filtro=todos (default) | no_leidos | leidos
//   ?limit=50 (default) | máximo 200

router.get('/recordatorios/:empresa_id', authMiddleware, async (req, res) => {
  const { user_id } = req.auth;
  const empresa_id  = req.params.empresa_id;
  const filtro      = (req.query.filtro || 'todos').toLowerCase();
  let limit         = parseInt(req.query.limit || '50', 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const filtrosValidos = ['todos', 'no_leidos', 'leidos'];
  if (!filtrosValidos.includes(filtro)) {
    return res.status(400).json({
      ok:    false,
      error: `Filtro inválido. Use uno de: ${filtrosValidos.join(', ')}`,
    });
  }

  try {
    // Ownership check
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', empresa_id)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[listar-recordatorios] Error validando empresa:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre esa empresa' });
    }

    // Query base
    let query = supabase
      .from('niko_recordatorios')
      .select('id, tipo, payload, leido, read_at, created_at')
      .eq('empresa_id', empresa_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (filtro === 'no_leidos') {
      query = query.eq('leido', false);
    } else if (filtro === 'leidos') {
      query = query.eq('leido', true);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[listar-recordatorios] Error consultando BD:', error.message);
      return res.status(500).json({ ok: false, error: 'Error consultando recordatorios' });
    }

    // Contador de no leídos para badge del frontend
    const { count: countNoLeidos, error: countErr } = await supabase
      .from('niko_recordatorios')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .eq('leido', false);

    if (countErr) {
      console.error('[listar-recordatorios] Error contando no leídos:', countErr.message);
    }

    return res.json({
      ok:             true,
      filtro,
      total:          data.length,
      no_leidos_total: countNoLeidos ?? 0,
      recordatorios:  data,
    });

  } catch (err) {
    console.error('[listar-recordatorios] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ─── DELETE /api/niko/recordatorios/:id ──────────────────────────────────────
//
// Elimina un recordatorio físicamente de BD.
// Requiere ownership de la empresa a la que pertenece el recordatorio.

router.delete('/recordatorios/:id', authMiddleware, async (req, res) => {
  const { user_id }     = req.auth;
  const recordatorio_id = req.params.id;

  try {
    // Obtener el recordatorio + su empresa_id
    const { data: recordatorio, error: recErr } = await supabase
      .from('niko_recordatorios')
      .select('id, empresa_id')
      .eq('id', recordatorio_id)
      .maybeSingle();

    if (recErr) {
      console.error('[eliminar-recordatorio] Error consultando:', recErr.message);
      return res.status(500).json({ ok: false, error: 'Error consultando recordatorio' });
    }
    if (!recordatorio) {
      return res.status(404).json({ ok: false, error: 'Recordatorio no encontrado' });
    }

    // Ownership check vía empresa
    const { data: empresa, error: empresaErr } = await supabase
      .from('empresas')
      .select('id')
      .eq('id', recordatorio.empresa_id)
      .eq('owner_id', user_id)
      .maybeSingle();

    if (empresaErr) {
      console.error('[eliminar-recordatorio] Error validando ownership:', empresaErr.message);
      return res.status(500).json({ ok: false, error: 'Error validando permisos' });
    }
    if (!empresa) {
      return res.status(403).json({ ok: false, error: 'Sin permisos sobre ese recordatorio' });
    }

    // Eliminar
    const { error: deleteErr } = await supabase
      .from('niko_recordatorios')
      .delete()
      .eq('id', recordatorio_id);

    if (deleteErr) {
      console.error('[eliminar-recordatorio] Error al eliminar:', deleteErr.message);
      return res.status(500).json({ ok: false, error: 'Error al eliminar recordatorio' });
    }

    return res.json({ ok: true, deleted: true, id: recordatorio_id });

  } catch (err) {
    console.error('[eliminar-recordatorio] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

module.exports = router;
