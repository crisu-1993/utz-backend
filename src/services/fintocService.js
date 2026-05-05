'use strict';

// ─── Servicio Fintoc — integración bancaria automática ────────────────────────
//
// Flujo general:
//   1. Frontend completa el widget de Fintoc y recibe un link_token
//   2. Backend llama registrarLink(linkToken, empresaId) → guarda en fintoc_links
//   3. Polling cada 1h llama sincronizarTodasLasEmpresas()
//   4. Por cada movimiento: cruce con PDFs existentes o inserción nueva
//
// SDK: client.links.get(token) | client.accounts.list({ link_token })
//      client.accounts.movements.list({ account_id, link_token, since })

const { Fintoc }        = require('fintoc');
const { createClient }  = require('@supabase/supabase-js');

// ─── Cliente Fintoc (singleton) ───────────────────────────────────────────────
function getFintocClient() {
  return new Fintoc(process.env.FINTOC_SECRET_KEY);
}

// ─── Cliente Supabase (service_role — igual que el resto del proyecto) ────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GESTIÓN DE LINKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registra un link_token del widget de Fintoc.
 * Llama a la API para obtener los datos del link y la primera cuenta,
 * guarda en fintoc_links y devuelve el registro creado.
 *
 * @param {string} linkToken  — token recibido del widget de Fintoc
 * @param {string} empresaId  — UUID de la empresa (de req.auth)
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
async function registrarLink(linkToken, empresaId) {
  const supabase = getSupabase();
  const fintoc   = getFintocClient();

  try {
    // 1. Obtener datos del link desde Fintoc
    console.log(`[fintoc] registrarLink — obteniendo datos para empresa ${empresaId}`);
    const link = await fintoc.links.get(linkToken);

    // 2. Obtener la primera cuenta del link
    const cuentas = await fintoc.accounts.list({ link_token: linkToken, lazy: false });
    const cuenta  = cuentas && cuentas.length > 0 ? cuentas[0] : null;

    // 3. Verificar si ya existe un link con este fintoc_link_id
    const { data: existente } = await supabase
      .from('fintoc_links')
      .select('id')
      .eq('fintoc_link_id', link.id)
      .maybeSingle();

    if (existente) {
      console.log(`[fintoc] link ${link.id} ya existe — actualizando estado a active`);
      const { data, error } = await supabase
        .from('fintoc_links')
        .update({ estado: 'active', updated_at: new Date().toISOString() })
        .eq('fintoc_link_id', link.id)
        .select()
        .single();

      if (error) throw new Error(`Error actualizando link existente: ${error.message}`);
      return { ok: true, data };
    }

    // 4. Insertar nuevo registro en fintoc_links
    const registro = {
      empresa_id:          empresaId,
      fintoc_link_id:      link.id,
      fintoc_link_token:   linkToken,
      fintoc_account_id:   cuenta?.id        || null,
      banco_id:            link.institution?.id   || null,
      banco_nombre:        link.institution?.name || null,
      cuenta_numero:       cuenta?.number    || null,
      cuenta_tipo:         cuenta?.type      || null,
      cuenta_holder_name:  cuenta?.holder_name || link.holder_name || null,
      estado:              'active',
      fecha_conexion:      new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('fintoc_links')
      .insert(registro)
      .select()
      .single();

    if (error) throw new Error(`Error guardando link en BD: ${error.message}`);

    console.log(`[fintoc] ✓ Link ${link.id} registrado para empresa ${empresaId}`);
    return { ok: true, data };

  } catch (err) {
    console.error('[fintoc] registrarLink error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Lista los links activos de una empresa.
 *
 * @param {string} empresaId
 * @returns {{ ok: boolean, data?: array, error?: string }}
 */
async function listarLinks(empresaId) {
  const supabase = getSupabase();

  try {
    const { data, error } = await supabase
      .from('fintoc_links')
      .select('id, fintoc_link_id, banco_nombre, cuenta_numero, cuenta_tipo, cuenta_holder_name, estado, ultima_sincronizacion, fecha_conexion')
      .eq('empresa_id', empresaId)
      .order('fecha_conexion', { ascending: false });

    if (error) throw new Error(error.message);

    return { ok: true, data: data || [] };

  } catch (err) {
    console.error('[fintoc] listarLinks error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Desactiva un link (soft delete: estado='revoked').
 * Verifica que el link pertenece a la empresa antes de actualizar.
 *
 * @param {string} fintocLinkId  — valor de la columna fintoc_link_id
 * @param {string} empresaId
 * @returns {{ ok: boolean, error?: string }}
 */
async function desactivarLink(fintocLinkId, empresaId) {
  const supabase = getSupabase();

  try {
    // Verificar que el link existe y pertenece a esta empresa
    const { data: link, error: findErr } = await supabase
      .from('fintoc_links')
      .select('id')
      .eq('fintoc_link_id', fintocLinkId)
      .eq('empresa_id', empresaId)
      .maybeSingle();

    if (findErr) throw new Error(findErr.message);

    if (!link) {
      return { ok: false, error: 'Link no encontrado o no pertenece a esta empresa' };
    }

    const { error } = await supabase
      .from('fintoc_links')
      .update({ estado: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', link.id);

    if (error) throw new Error(error.message);

    console.log(`[fintoc] ✓ Link ${fintocLinkId} revocado para empresa ${empresaId}`);
    return { ok: true };

  } catch (err) {
    console.error('[fintoc] desactivarLink error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINCRONIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sincroniza movimientos de un link específico.
 * Trae movimientos desde ultima_sincronizacion (o todo el histórico si es la primera vez).
 * Aplica lógica de cruce con PDFs existentes.
 *
 * @param {string} fintocLinkId  — valor de fintoc_link_id (no el UUID interno)
 * @param {string} ejecutadoPor  — 'manual' | 'cron' (para el log)
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
async function sincronizarLink(fintocLinkId, ejecutadoPor = 'manual') {
  const supabase = getSupabase();
  const fintoc   = getFintocClient();
  const inicio   = new Date();

  console.log(`[fintoc] sincronizarLink ${fintocLinkId} (ejecutadoPor: ${ejecutadoPor})`);

  try {
    // 1. Obtener el link desde nuestra BD
    const { data: linkBD, error: linkErr } = await supabase
      .from('fintoc_links')
      .select('*')
      .eq('fintoc_link_id', fintocLinkId)
      .eq('estado', 'active')
      .maybeSingle();

    if (linkErr) throw new Error(linkErr.message);
    if (!linkBD) throw new Error(`Link ${fintocLinkId} no encontrado o no está activo`);

    // 2. Determinar fecha de inicio para traer movimientos
    //    Si es la primera vez (sin ultima_sincronizacion): traer todo sin filtro de fecha
    const sinceParam = linkBD.ultima_sincronizacion
      ? linkBD.ultima_sincronizacion.split('T')[0]   // solo la fecha YYYY-MM-DD
      : null;

    if (sinceParam) {
      console.log(`[fintoc] trayendo movimientos desde ${sinceParam}`);
    } else {
      console.log('[fintoc] primera sincronización — trayendo histórico completo');
    }

    // 3. Obtener movimientos desde Fintoc
    const params = {
      account_id: linkBD.fintoc_account_id,
      link_token: linkBD.fintoc_link_token,
      lazy: false,
    };
    if (sinceParam) params.since = sinceParam;

    const movimientos = await fintoc.accounts.movements.list(params);
    console.log(`[fintoc] movimientos recibidos de Fintoc: ${movimientos.length}`);

    // 4. Procesar cada movimiento con la lógica de cruce
    let nuevos      = 0;
    let duplicados  = 0;
    let verificados = 0;

    for (const mov of movimientos) {
      const resultado = await procesarMovimiento(supabase, mov, linkBD);
      if (resultado === 'nuevo')       nuevos++;
      else if (resultado === 'dup')    duplicados++;
      else if (resultado === 'cruzado') verificados++;
    }

    // 5. Actualizar ultima_sincronizacion
    await supabase
      .from('fintoc_links')
      .update({
        ultima_sincronizacion: new Date().toISOString(),
        updated_at:            new Date().toISOString(),
      })
      .eq('id', linkBD.id);

    // 6. Registrar en fintoc_sync_log
    const resumen = { nuevos, duplicados, verificados };
    await registrarSyncLog(linkBD.fintoc_link_id, linkBD.empresa_id, {
      inicio,
      fin:       new Date(),
      estado:    'success',
      ejecutadoPor,
      ...resumen,
    });

    console.log(`[fintoc] ✓ Sync completado — nuevos: ${nuevos}, verificados: ${verificados}, duplicados: ${duplicados}`);
    return { ok: true, data: resumen };

  } catch (err) {
    console.error(`[fintoc] sincronizarLink error (${fintocLinkId}):`, err.message);

    // Registrar error en log
    await registrarSyncLog(fintocLinkId, null, {
      inicio,
      fin:         new Date(),
      estado:      'error',
      ejecutadoPor,
      error_mensaje: err.message,
    }).catch(() => {});

    return { ok: false, error: err.message };
  }
}

/**
 * Procesa un movimiento individual de Fintoc.
 * Aplica lógica de cruce PDF/Fintoc según las especificaciones del proyecto.
 *
 * @returns {'nuevo' | 'dup' | 'cruzado'}
 */
async function procesarMovimiento(supabase, mov, linkBD) {
  const movementId = mov.id;
  const empresaId  = linkBD.empresa_id;

  // PASO A — Verificar si ya existe por fintoc_movement_id (duplicado exacto)
  const dupFintoc = await buscarDuplicadoPorMovementId(supabase, movementId);
  if (dupFintoc) {
    return 'dup';
  }

  // Calcular campos comunes
  const tipo      = mov.amount < 0 ? 'egreso' : 'ingreso';
  const montoAbs  = Math.abs(mov.amount);
  const fecha     = mov.post_date
    ? String(mov.post_date).split('T')[0]  // asegurar formato YYYY-MM-DD sin hora
    : null;

  if (!fecha || montoAbs <= 0) {
    console.log(`[fintoc] movimiento ${movementId} sin fecha o monto válido — saltando`);
    return 'dup';  // no insertar datos inválidos
  }

  // PASO B — Buscar coincidencia con registro PDF existente
  const coincidencia = await buscarCoincidenciaPDF(supabase, empresaId, fecha, montoAbs, tipo);

  if (coincidencia) {
    // Actualizar el registro PDF con la verificación de Fintoc
    await marcarComoVerificada(supabase, coincidencia.id, movementId, linkBD.fintoc_link_id);
    return 'cruzado';
  }

  // PASO C — No existe ni en Fintoc ni en PDF: insertar nuevo registro
  await insertarMovimientoFintoc(supabase, mov, linkBD.fintoc_link_id, empresaId, fecha, tipo, montoAbs);
  return 'nuevo';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS DE CRUCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PASO A — Busca duplicado exacto por fintoc_movement_id.
 * Si existe, el movimiento ya fue procesado antes → SKIP.
 */
async function buscarDuplicadoPorMovementId(supabase, movementId) {
  const { data, error } = await supabase
    .from('transacciones_historicas')
    .select('id')
    .eq('fintoc_movement_id', movementId)
    .maybeSingle();

  if (error) {
    console.error('[fintoc] buscarDuplicadoPorMovementId error:', error.message);
    return null;
  }
  return data;  // null si no existe
}

/**
 * PASO B — Busca coincidencia con un registro de cartola PDF.
 * Criterio: misma empresa + fecha + monto (absoluto) + tipo + fuente='cartola_banco' + sin cruzar aún.
 */
async function buscarCoincidenciaPDF(supabase, empresaId, fecha, montoAbs, tipo) {
  const { data, error } = await supabase
    .from('transacciones_historicas')
    .select('id')
    .eq('empresa_id', empresaId)
    .eq('fecha_transaccion', fecha)
    .eq('monto_original', montoAbs)
    .eq('tipo', tipo)
    .eq('fuente', 'cartola_banco')           // registros importados desde PDF
    .is('fintoc_movement_id', null)           // solo los que aún no han sido cruzados
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[fintoc] buscarCoincidenciaPDF error:', error.message);
    return null;
  }
  return data;  // null si no hay coincidencia
}

/**
 * Marca un registro PDF existente como verificado por Fintoc.
 */
async function marcarComoVerificada(supabase, transaccionId, movementId, linkId) {
  const { error } = await supabase
    .from('transacciones_historicas')
    .update({
      verificada_por_fintoc: true,
      fintoc_movement_id:    movementId,
      fintoc_link_id:        linkId,
    })
    .eq('id', transaccionId);

  if (error) {
    console.error(`[fintoc] marcarComoVerificada error (tx ${transaccionId}):`, error.message);
  }
}

/**
 * Inserta un movimiento nuevo de Fintoc en transacciones_historicas.
 */
async function insertarMovimientoFintoc(supabase, mov, linkId, empresaId, fecha, tipo, montoAbs) {
  const registro = {
    empresa_id:              empresaId,
    importacion_id:          null,
    fecha_transaccion:       fecha,
    descripcion_original:    mov.description  || '',
    descripcion_normalizada: mov.description  || '',
    numero_documento:        mov.reference_id || null,
    tipo,
    monto_original:          montoAbs,
    saldo_posterior:         null,            // Fintoc no provee saldo en movimientos
    moneda_original:         mov.currency     || 'CLP',
    categoria_sugerida_ia:   null,            // post-MVP: categorizar con Claude
    confianza_deteccion:     null,
    estado:                  'pendiente_revision',
    fuente:                  'fintoc',
    archivo_origen:          null,
    fintoc_movement_id:      mov.id,
    verificada_por_fintoc:   false,           // false: es de Fintoc, no un PDF verificado
    fintoc_link_id:          linkId,
  };

  const { error } = await supabase
    .from('transacciones_historicas')
    .insert(registro);

  if (error) {
    // El índice único en fintoc_movement_id puede fallar en condición de carrera — no es fatal
    if (error.code === '23505') {
      console.log(`[fintoc] movimiento ${mov.id} ya insertado (race condition) — ignorando`);
    } else {
      console.error(`[fintoc] insertarMovimientoFintoc error (${mov.id}):`, error.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRON — SINCRONIZACIÓN DE TODAS LAS EMPRESAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ejecuta la sincronización de todos los links activos en todas las empresas.
 * Llamado por el setInterval en index.js cada 60 minutos.
 */
async function sincronizarTodasLasEmpresas() {
  const supabase = getSupabase();
  console.log('[fintoc-cron] Iniciando sincronización periódica...');

  try {
    // Obtener todos los links activos
    const { data: links, error } = await supabase
      .from('fintoc_links')
      .select('fintoc_link_id, empresa_id, banco_nombre')
      .eq('estado', 'active');

    if (error) throw new Error(error.message);

    if (!links || links.length === 0) {
      console.log('[fintoc-cron] Sin links activos que sincronizar');
      return;
    }

    console.log(`[fintoc-cron] Sincronizando ${links.length} link(s)...`);

    // Sincronizar cada link de forma secuencial para no saturar la API de Fintoc
    for (const link of links) {
      console.log(`[fintoc-cron] → ${link.banco_nombre || link.fintoc_link_id} (empresa: ${link.empresa_id})`);
      await sincronizarLink(link.fintoc_link_id, 'cron');
    }

    console.log('[fintoc-cron] ✓ Sincronización periódica completada');

  } catch (err) {
    console.error('[fintoc-cron] Error en sincronización periódica:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC LOG Y ESTADO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registra el resultado de una sincronización en fintoc_sync_log.
 */
async function registrarSyncLog(fintocLinkId, empresaId, resultados) {
  const supabase = getSupabase();

  const {
    inicio, fin, estado, ejecutadoPor,
    nuevos = 0, duplicados = 0, verificados = 0, error_mensaje = null,
  } = resultados;

  const { error } = await supabase
    .from('fintoc_sync_log')
    .insert({
      fintoc_link_id:               fintocLinkId,
      empresa_id:                    empresaId,
      inicio:                        inicio ? inicio.toISOString() : new Date().toISOString(),
      fin:                           fin    ? fin.toISOString()    : new Date().toISOString(),
      estado,
      movimientos_nuevos:            nuevos,
      movimientos_duplicados:        duplicados,
      movimientos_verificados_pdf:   verificados,
      error_mensaje,
      ejecutado_por:                 ejecutadoPor || 'manual',
    });

  if (error) {
    console.error('[fintoc] registrarSyncLog error:', error.message);
  }
}

/**
 * Devuelve el estado del último sync de una empresa.
 */
async function obtenerEstadoUltimoSync(empresaId) {
  const supabase = getSupabase();

  try {
    // Obtener el log más reciente para cualquier link de esta empresa
    const { data, error } = await supabase
      .from('fintoc_sync_log')
      .select('*')
      .eq('empresa_id', empresaId)
      .order('inicio', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);

    // Obtener resumen de links activos de la empresa
    const { data: links } = await supabase
      .from('fintoc_links')
      .select('fintoc_link_id, banco_nombre, estado, ultima_sincronizacion')
      .eq('empresa_id', empresaId);

    return {
      ok:              true,
      ultimo_sync:     data || null,
      links:           links || [],
    };

  } catch (err) {
    console.error('[fintoc] obtenerEstadoUltimoSync error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verifica que la conexión con Fintoc API está funcionando.
 * Llama a whoami para validar las credenciales.
 */
async function healthCheck() {
  const fintoc = getFintocClient();

  try {
    const whoami = await fintoc.whoami.get();
    console.log('[fintoc] health check OK:', whoami?.id || 'conectado');
    return { ok: true, fintoc_status: 'connected', data: whoami };

  } catch (err) {
    console.error('[fintoc] health check FAIL:', err.message);
    return { ok: false, fintoc_status: 'error', error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  registrarLink,
  listarLinks,
  desactivarLink,
  sincronizarLink,
  sincronizarTodasLasEmpresas,
  buscarDuplicadoPorMovementId,
  buscarCoincidenciaPDF,
  insertarMovimientoFintoc,
  marcarComoVerificada,
  registrarSyncLog,
  obtenerEstadoUltimoSync,
  healthCheck,
};
