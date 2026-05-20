'use strict';

// ─── Rutas /api/recordatorios ─────────────────────────────────────────────────
//
// Endpoints:
//   GET    /api/recordatorios        → listar recordatorios de la empresa
//   POST   /api/recordatorios        → crear recordatorio
//   PATCH  /api/recordatorios/:id    → actualizar recordatorio
//   DELETE /api/recordatorios/:id    → eliminar recordatorio

const express                = require('express');
const { createClient }       = require('@supabase/supabase-js');
const { authMiddleware }     = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── GET /api/recordatorios ───────────────────────────────────────────────────
// Query params opcionales:
//   ?completado=true|false
//   ?fecha_desde=YYYY-MM-DD
//   ?fecha_hasta=YYYY-MM-DD
router.get('/', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { completado, fecha_desde, fecha_hasta } = req.query;

  const supabase = getSupabase();

  try {
    let query = supabase
      .from('recordatorios')
      .select('*')
      .eq('empresa_id', empresa_id)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (completado !== undefined) {
      query = query.eq('completado', completado === 'true');
    }

    if (fecha_desde) {
      query = query.gte('fecha_vencimiento', fecha_desde);
    }

    if (fecha_hasta) {
      query = query.lte('fecha_vencimiento', fecha_hasta);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    return res.json({ ok: true, recordatorios: data });

  } catch (err) {
    console.error('[recordatorios] Error en GET /', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── crearRecordatorio ────────────────────────────────────────────────────────
//
// Función pura: valida y crea un recordatorio en la tabla 'recordatorios'.
// Usada internamente por el endpoint POST y por la tool de Niko.
//
// @param {object} params
//   empresa_id        {string}  UUID de la empresa
//   user_id           {string}  UUID del usuario
//   titulo            {string}  Texto del recordatorio (requerido, max 200 chars)
//   descripcion       {string?} Detalle adicional (opcional)
//   fecha_vencimiento {string?} Fecha en formato YYYY-MM-DD (opcional)
//   origen            {string?} 'manual' (default) | 'niko_a_pedido'
// @returns {object} { ok: true, recordatorio } | { ok: false, mensaje, status }

async function crearRecordatorio({ empresa_id, user_id, titulo, descripcion, fecha_vencimiento, hora_vencimiento, origen }) {
  const origenFinal = origen ?? 'manual';

  if (!titulo || !String(titulo).trim()) {
    return { ok: false, mensaje: 'El campo "titulo" es requerido', status: 400 };
  }

  if (String(titulo).trim().length > 200) {
    return { ok: false, mensaje: 'El título no puede superar 200 caracteres', status: 400 };
  }

  if (fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
    return { ok: false, mensaje: 'fecha_vencimiento debe tener formato YYYY-MM-DD', status: 400 };
  }

  if (!['manual', 'niko_a_pedido'].includes(origenFinal)) {
    return { ok: false, mensaje: 'origen debe ser "manual" o "niko_a_pedido"', status: 400 };
  }

  // Validar formato de hora_vencimiento (opcional)
  // Acepta HH:MM o HH:MM:SS. Vacío o undefined → NULL.
  let horaFinal = '09:00:00'; // Default si no llega o llega vacío
  if (hora_vencimiento && String(hora_vencimiento).trim() !== '') {
    const horaStr = String(hora_vencimiento).trim();
    const regexHora = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
    if (!regexHora.test(horaStr)) {
      return { ok: false, mensaje: 'Formato de hora inválido (esperado HH:MM)', status: 400 };
    }
    horaFinal = horaStr.length === 5 ? `${horaStr}:00` : horaStr;
  }

  const supabase = getSupabase();

  // Calcular titulo limpio una vez (reutilizado abajo)
  const tituloLimpio = String(titulo).trim();

  try {
    // ── Anti-duplicados (solo para niko_a_pedido) ─────────────────────────
    if (origenFinal === 'niko_a_pedido') {
      const sesentaSegundosAtras = new Date(Date.now() - 60000).toISOString();

      const { data: existente, error: errExistente } = await supabase
        .from('recordatorios')
        .select('*')
        .eq('empresa_id', empresa_id)
        .eq('titulo', tituloLimpio)
        .eq('fecha_vencimiento', fecha_vencimiento || null)
        .eq('hora_vencimiento', horaFinal)
        .eq('origen', origenFinal)
        .gte('created_at', sesentaSegundosAtras)
        .maybeSingle();

      if (errExistente) {
        console.warn('[crearRecordatorio] Error verificando duplicado, continuando:', errExistente.message);
      } else if (existente) {
        console.warn('[crearRecordatorio] Duplicado detectado, devolviendo existente:', { empresa_id, titulo: tituloLimpio, fecha_vencimiento });
        return { ok: true, recordatorio: existente };
      }
    }

    const payload = {
      empresa_id,
      user_id,
      titulo:            tituloLimpio,
      descripcion:       descripcion ? String(descripcion).trim() : null,
      fecha_vencimiento: fecha_vencimiento || null,
      hora_vencimiento:  horaFinal,
      origen:            origenFinal,
    };

    const { data, error } = await supabase
      .from('recordatorios')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return { ok: true, recordatorio: data };

  } catch (err) {
    console.error('[recordatorios] Error en crearRecordatorio:', err.message);
    return { ok: false, mensaje: err.message, status: 500 };
  }
}

// ─── POST /api/recordatorios ──────────────────────────────────────────────────
// Body: { titulo, descripcion?, fecha_vencimiento?, hora_vencimiento? }
router.post('/', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { titulo, descripcion, fecha_vencimiento, hora_vencimiento } = req.body || {};

  const resultado = await crearRecordatorio({
    empresa_id,
    user_id,
    titulo,
    descripcion,
    fecha_vencimiento,
    hora_vencimiento,
    origen: 'manual',
  });

  if (!resultado.ok) {
    return res.status(resultado.status || 500).json({ ok: false, error: resultado.mensaje });
  }

  return res.status(201).json({ ok: true, recordatorio: resultado.recordatorio });
});

// ─── listarRecordatorios ────────────────────────────────────────────────────────────────
//
// Función pura: lista recordatorios de una empresa con filtros opcionales.
// Usada por la tool listar_recordatorios de Niko.
//
// @param {object} params
//   empresa_id      {string}   UUID de la empresa (requerido)
//   scope           {string?}  "activos" (ya vencidos) | "proximos" (futuros) | omitido (todos)
//   titulo_busqueda {string?}  Filtro por texto parcial del título
//   completado      {boolean?} Si viene, filtra por estado completado
// @returns {object} { ok: true, recordatorios: [...] } | { ok: false, mensaje, status }

// ─── esRecordatorioActivo (portada del frontend src/lib/recordatorios.ts) ───
// ACTIVO = pendiente Y (sin fecha O fecha+hora ya pasó en timezone Chile).
function esRecordatorioActivo(r) {
  if (r.completado) return false;
  if (!r.fecha_vencimiento) return true;
  const ahora = new Date();
  const fechaChile = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  const horaChile  = ahora.toLocaleTimeString('en-GB', { timeZone: 'America/Santiago', hour12: false });
  const ahoraChile = `${fechaChile} ${horaChile}`;
  const hora = r.hora_vencimiento || '09:00:00';
  const horaNorm = hora.length === 5 ? `${hora}:00` : hora;
  return `${r.fecha_vencimiento} ${horaNorm}` <= ahoraChile;
}

async function listarRecordatorios({ empresa_id, scope, titulo_busqueda, completado }) {
  const supabase = getSupabase();

  try {
    // RAMA 1: Búsqueda específica con titulo_busqueda → usar RPC con unaccent.
    // No aplica filtro de fecha (busca en toda la BD). Tolerante a acentos.
    if (titulo_busqueda) {
      const { data, error } = await supabase.rpc('buscar_recordatorios', {
        p_empresa_id: empresa_id,
        p_busqueda:   titulo_busqueda,
        p_completado: completado !== undefined ? completado : null,
      });

      if (error) throw new Error(error.message);

      return { ok: true, recordatorios: data || [] };
    }

    // RAMA 2: Listado abierto (sin titulo_busqueda).
    // Trae todos los registros (límite alto de respaldo) y clasifica en JS.
    // scope: "activos" = ya vencidos pendientes | "proximos" = futuros pendientes | undefined = todos.
    let query = supabase
      .from('recordatorios')
      .select('*')
      .eq('empresa_id', empresa_id)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: true })
      .limit(200);

    if (completado !== undefined) {
      query = query.eq('completado', completado);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    let recordatorios = data || [];

    // Clasificación temporal en JS (misma lógica que el frontend).
    if (scope === 'activos') {
      recordatorios = recordatorios.filter(r => esRecordatorioActivo(r));
    } else if (scope === 'proximos') {
      recordatorios = recordatorios.filter(r => !r.completado && !esRecordatorioActivo(r) && !!r.fecha_vencimiento);
    }

    return { ok: true, recordatorios };

  } catch (err) {
    console.error('[recordatorios] Error en listarRecordatorios:', err.message);
    return { ok: false, mensaje: err.message, status: 500 };
  }
}

// ─── actualizarRecordatorio ────────────────────────────────────────────────────────────────
//
// Función pura: actualiza campos de un recordatorio existente.
// Usada por el endpoint PATCH y por la tool de Niko.
//
// @param {object} params
//   empresa_id        {string}   UUID de la empresa (ownership check)
//   id                {string}   UUID del recordatorio
//   titulo            {string?}  Nuevo título
//   descripcion       {string?}  Nueva descripción (null borra la actual)
//   fecha_vencimiento {string?}  Nueva fecha YYYY-MM-DD (null borra la actual)
//   completado        {boolean?} true/false para completar/descompletar
// @returns {object} { ok: true, recordatorio } | { ok: false, mensaje, status }

async function actualizarRecordatorio({ empresa_id, id, titulo, descripcion, fecha_vencimiento, hora_vencimiento, completado }) {
  const supabase = getSupabase();

  try {
    // Ownership check
    const { data: existente, error: errBuscar } = await supabase
      .from('recordatorios')
      .select('id')
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (errBuscar) throw new Error(errBuscar.message);

    if (!existente) {
      return { ok: false, mensaje: 'Recordatorio no encontrado', status: 404 };
    }

    // Construir solo los campos que vienen != undefined
    const updates = { updated_at: new Date().toISOString() };

    if (titulo !== undefined) {
      if (!String(titulo).trim()) {
        return { ok: false, mensaje: 'El título no puede estar vacío', status: 400 };
      }
      if (String(titulo).trim().length > 200) {
        return { ok: false, mensaje: 'El título no puede superar 200 caracteres', status: 400 };
      }
      updates.titulo = String(titulo).trim();
    }

    if (descripcion !== undefined) {
      updates.descripcion = descripcion ? String(descripcion).trim() : null;
    }

    if (fecha_vencimiento !== undefined) {
      if (fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
        return { ok: false, mensaje: 'fecha_vencimiento debe tener formato YYYY-MM-DD', status: 400 };
      }
      updates.fecha_vencimiento = fecha_vencimiento || null;
    }

    if (hora_vencimiento !== undefined) {
      if (hora_vencimiento === null || hora_vencimiento === '') {
        updates.hora_vencimiento = '09:00:00'; // Default si se "borra"
      } else {
        const horaStr = String(hora_vencimiento).trim();
        const regexHora = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
        if (!regexHora.test(horaStr)) {
          return { ok: false, mensaje: 'Formato de hora inválido (esperado HH:MM)', status: 400 };
        }
        updates.hora_vencimiento = horaStr.length === 5 ? `${horaStr}:00` : horaStr;
      }
    }

    if (completado !== undefined) {
      updates.completado = Boolean(completado);
    }

    const { data, error } = await supabase
      .from('recordatorios')
      .update(updates)
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return { ok: true, recordatorio: data };

  } catch (err) {
    console.error('[recordatorios] Error en actualizarRecordatorio:', err.message);
    return { ok: false, mensaje: err.message, status: 500 };
  }
}

// ─── eliminarRecordatorio ────────────────────────────────────────────────────────────────────
//
// Función pura: elimina un recordatorio por id.
// Usada por el endpoint DELETE y por la tool de Niko.
//
// @param {object} params
//   empresa_id {string} UUID de la empresa (ownership check)
//   id         {string} UUID del recordatorio
// @returns {object} { ok: true, id } | { ok: false, mensaje, status }

async function eliminarRecordatorio({ empresa_id, id }) {
  const supabase = getSupabase();

  try {
    // Ownership check
    const { data: existente, error: errBuscar } = await supabase
      .from('recordatorios')
      .select('id')
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (errBuscar) throw new Error(errBuscar.message);

    if (!existente) {
      return { ok: false, mensaje: 'Recordatorio no encontrado', status: 404 };
    }

    const { error } = await supabase
      .from('recordatorios')
      .delete()
      .eq('id', id)
      .eq('empresa_id', empresa_id);

    if (error) throw new Error(error.message);

    return { ok: true, id };

  } catch (err) {
    console.error('[recordatorios] Error en eliminarRecordatorio:', err.message);
    return { ok: false, mensaje: err.message, status: 500 };
  }
}

// ─── PATCH /api/recordatorios/:id ────────────────────────────────────────────
// Body: { titulo?, descripcion?, fecha_vencimiento?, completado? }
router.patch('/:id', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { id }         = req.params;
  const { titulo, descripcion, fecha_vencimiento, hora_vencimiento, completado } = req.body || {};

  const resultado = await actualizarRecordatorio({
    empresa_id, id, titulo, descripcion, fecha_vencimiento, hora_vencimiento, completado,
  });

  if (!resultado.ok) {
    return res.status(resultado.status || 500).json({ ok: false, error: resultado.mensaje });
  }

  return res.json({ ok: true, recordatorio: resultado.recordatorio });
});


// ─── DELETE /api/recordatorios/:id ───────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { id }         = req.params;

  const resultado = await eliminarRecordatorio({ empresa_id, id });

  if (!resultado.ok) {
    return res.status(resultado.status || 500).json({ ok: false, error: resultado.mensaje });
  }

  return res.json({ ok: true, id: resultado.id });
});

module.exports                        = router;
module.exports.crearRecordatorio      = crearRecordatorio;
module.exports.listarRecordatorios    = listarRecordatorios;
module.exports.actualizarRecordatorio = actualizarRecordatorio;
module.exports.eliminarRecordatorio   = eliminarRecordatorio;
