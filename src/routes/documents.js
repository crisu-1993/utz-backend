const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { procesarExcel } = require('../services/documentProcessor/excelProcessor');
const { procesarPDF } = require('../services/documentProcessor/pdfProcessor');
const { categorizarTransacciones } = require('../services/documentProcessor/aiCategorizer');
const { authMiddleware } = require('../middleware/auth');
const { esTransaccionDuplicada, contarTransaccionesEnBD, contarOcurrenciasEnLote } = require('./webhooks');

const router = express.Router();

// ─── Cliente Supabase con service_role (acceso total) ────────────────────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Detectar tipo de archivo ─────────────────────────────────────────────────
function detectarTipo(nombreArchivo) {
  const ext = (nombreArchivo || '').split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (ext === 'csv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  return null;
}

/**
 * Reconcilia duplicados dentro de una importación.
 * Compara cuántas transacciones idénticas hay en BD vs cuántas hay en el PDF original.
 * Si BD tiene más que PDF, elimina las más recientes hasta igualar.
 *
 * Esto resuelve el race condition: cuando webhook y /process insertan la misma tx
 * en paralelo, ambos ven que no existe y la insertan, dejando 2 en BD.
 *
 * NO toca transacciones de OTRAS importaciones — solo la indicada.
 *
 * @returns {Promise<{eliminadas: number, gruposReconciliados: number}>}
 */
async function reconciliarDuplicados(supabase, importacionId, registrosPDF) {
  if (!importacionId) {
    console.log('[RECONCILIAR] sin importacion_id, saltando reconciliación');
    return { eliminadas: 0, gruposReconciliados: 0 };
  }

  // 1. Contar ocurrencias en PDF (cuántas veces aparece cada combinación única)
  const cuentasPDF = {};
  for (const r of registrosPDF) {
    const docto = r.numero_documento || 'NULL';
    const clave = `${r.fecha_transaccion}|${r.monto_original}|${r.tipo}|${docto}`;
    cuentasPDF[clave] = (cuentasPDF[clave] || 0) + 1;
  }

  let eliminadasTotal = 0;
  let gruposReconciliados = 0;

  // 2. Para cada clave única en PDF, ver cuántas hay en BD
  for (const [clave, esperado] of Object.entries(cuentasPDF)) {
    const [fecha, monto, tipo, docto] = clave.split('|');

    let query = supabase
      .from('transacciones_historicas')
      .select('id, created_at')
      .eq('importacion_id', importacionId)
      .eq('fecha_transaccion', fecha)
      .eq('monto_original', parseFloat(monto))
      .eq('tipo', tipo);

    // Manejo correcto de NULL en numero_documento
    if (docto === 'NULL') {
      query = query.is('numero_documento', null);
    } else {
      query = query.eq('numero_documento', docto);
    }

    // Ordenar por created_at DESC: los más recientes primero
    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error(`[RECONCILIAR] Error consultando ${clave}:`, error.message);
      continue;
    }

    if (!data) continue;

    // 3. Si BD tiene más que el PDF dice, eliminar el exceso (los más recientes)
    if (data.length > esperado) {
      const exceso = data.length - esperado;
      const idsAEliminar = data.slice(0, exceso).map(t => t.id);

      const { error: errorDelete } = await supabase
        .from('transacciones_historicas')
        .delete()
        .in('id', idsAEliminar);

      if (errorDelete) {
        console.error(`[RECONCILIAR] Error eliminando ${idsAEliminar.length} filas:`, errorDelete.message);
        continue;
      }

      console.log(`[RECONCILIAR] ${clave}: BD=${data.length}, PDF=${esperado}, eliminadas ${exceso} (ids: ${idsAEliminar.join(', ')})`);
      eliminadasTotal += exceso;
      gruposReconciliados++;
    }
  }

  if (eliminadasTotal > 0) {
    console.log(`[RECONCILIAR] Total: ${eliminadasTotal} duplicados eliminados de ${gruposReconciliados} grupos`);
  } else {
    console.log(`[RECONCILIAR] Sin duplicados detectados (${Object.keys(cuentasPDF).length} grupos verificados)`);
  }

  return { eliminadas: eliminadasTotal, gruposReconciliados };
}

// ─── POST /api/documents/process ─────────────────────────────────────────────
// Requiere Authorization: Bearer <token de Supabase>
// El empresa_id se obtiene del token autenticado; no se toma del body.
router.post('/process', authMiddleware, async (req, res) => {
  const { archivo_id, importacion_id, bucket_name = 'documentos' } = req.body;

  // empresa_id y user_id vienen del token validado por authMiddleware
  const { empresa_id, user_id } = req.auth;

  // Validaciones
  if (!archivo_id) {
    return res.status(400).json({
      error: 'Falta campo requerido: archivo_id',
    });
  }

  const supabase = getSupabase();
  const inicio = Date.now();

  try {
    // ── 1. Marcar importacion como "procesando" ───────────────────────────────
    if (importacion_id) {
      await supabase
        .from('importaciones_historicas')
        .update({
          estado: 'procesando',
          fecha_inicio_procesamiento: new Date().toISOString(),
          storage_path: archivo_id,  // para que webhook pueda encontrar esta importación
          archivo_path: archivo_id,  // redundante pero consistente con webhook
        })
        .eq('id', importacion_id);
    }

    // ── 2. Descargar archivo desde Supabase Storage ───────────────────────────
    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from(bucket_name)
      .download(archivo_id);

    if (downloadError) {
      throw new Error(`No se pudo descargar el archivo: ${downloadError.message}`);
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const nombreArchivo = archivo_id.split('/').pop();
    const tipo = detectarTipo(nombreArchivo);

    if (!tipo) {
      throw new Error(`Tipo de archivo no soportado: ${nombreArchivo}. Use Excel, CSV o PDF.`);
    }

    // ── 3. Procesar según tipo ────────────────────────────────────────────────
    console.log(`[documentos] Procesando ${nombreArchivo} (${tipo}) para empresa ${empresa_id} (user: ${user_id})`);

    let transacciones;
    if (tipo === 'excel' || tipo === 'csv') {
      transacciones = procesarExcel(buffer, nombreArchivo);
    } else {
      transacciones = await procesarPDF(buffer);
    }

    console.log(`[documentos] Extraídas ${transacciones.length} transacciones`);

    // ── 4. Categorizar con IA ─────────────────────────────────────────────────
    console.log('[documentos] Categorizando con Claude...');
    const transaccionesCategorizadas = await categorizarTransacciones(transacciones);
    console.log('[documentos] Categorización completada');

    // ── 5. Preparar registros para Supabase ───────────────────────────────────
    const registros = transaccionesCategorizadas.map(t => ({
      empresa_id,
      importacion_id:          importacion_id || null,
      fecha_transaccion:       t.fecha_transaccion,
      descripcion_original:    t.descripcion_original,
      descripcion_normalizada: t.descripcion_normalizada,
      numero_documento:        t.numero_documento || null,
      tipo:                    t.tipo,
      monto_original:          t.monto_original,
      saldo_posterior:         t.saldo_posterior || null,
      moneda_original:         t.moneda_original || 'CLP',
      categoria_sugerida_ia:   t.categoria_sugerida_ia || null,
      confianza_deteccion:     t.confianza_deteccion || null,
      estado:                  'pendiente_revision',
      fuente:                  t.fuente || 'cartola_banco',
      archivo_origen:          nombreArchivo,
    }));

    // ── 6. Guardar transacciones en Supabase ──────────────────────────────────
    const BATCH = 100; // insertar en lotes para no exceder límites
    let insertados = 0;
    let saltadasTotal = 0;

    for (let i = 0; i < registros.length; i += BATCH) {
      const lote = registros.slice(i, i + BATCH);

      // Anti-duplicados: conteo PDF vs BD (resuelve race condition y docto null)
      const checks = await Promise.all(
        lote.map(async tx => {
          const ocurrenciasEnPDF = contarOcurrenciasEnLote(registros, tx);
          const ocurrenciasEnBD  = await contarTransaccionesEnBD(supabase, empresa_id, tx);
          return { tx, esDuplicado: ocurrenciasEnBD >= ocurrenciasEnPDF };
        })
      );

      const loteFiltrado = checks.filter(c => !c.esDuplicado).map(c => c.tx);
      const saltadasLote = lote.length - loteFiltrado.length;
      saltadasTotal += saltadasLote;

      console.log(`[/process] Lote ${Math.floor(i/BATCH)+1}: ${lote.length} total, ${loteFiltrado.length} nuevas, ${saltadasLote} duplicadas saltadas`);

      // Solo insertar si hay transacciones nuevas
      if (loteFiltrado.length > 0) {
        const { error: insertError } = await supabase
          .from('transacciones_historicas')
          .insert(loteFiltrado);

        if (insertError) {
          throw new Error(`Error al guardar transacciones: ${insertError.message}`);
        }
        insertados += loteFiltrado.length;
      }
    }

    console.log(`[/process] Procesamiento finalizado. Insertadas: ${insertados}, Saltadas (duplicadas): ${saltadasTotal}, Total cartola: ${registros.length}`);

    // ── 7. Calcular totales ───────────────────────────────────────────────────
    const totalIngresos = registros
      .filter(r => r.tipo === 'ingreso')
      .reduce((sum, r) => sum + r.monto_original, 0);

    const totalEgresos = registros
      .filter(r => r.tipo === 'egreso')
      .reduce((sum, r) => sum + r.monto_original, 0);

    // ── 8. Actualizar importacion_historica con resultado ─────────────────────
    if (importacion_id) {
      await supabase
        .from('importaciones_historicas')
        .update({
          estado:                   'completado',
          total_transacciones:      insertados,
          total_ingresos:           totalIngresos,
          total_egresos:            totalEgresos,
          fecha_fin_procesamiento:  new Date().toISOString(),
          tiempo_procesamiento_ms:  Date.now() - inicio,
        })
        .eq('id', importacion_id);
    }

    const tiempoMs = Date.now() - inicio;
    console.log(`[documentos] ✓ ${insertados} transacciones guardadas en ${tiempoMs}ms`);

    // Reconciliación: eliminar duplicados creados por race condition con webhook
    const reconciliacion = await reconciliarDuplicados(supabase, importacion_id, registros);

    // Si se eliminaron duplicados, recalcular total_transacciones de la importación
    if (reconciliacion.eliminadas > 0 && importacion_id) {
      const { count } = await supabase
        .from('transacciones_historicas')
        .select('id', { count: 'exact', head: true })
        .eq('importacion_id', importacion_id);

      await supabase
        .from('importaciones_historicas')
        .update({ total_transacciones: count || 0 })
        .eq('id', importacion_id);

      console.log(`[RECONCILIAR] total_transacciones actualizado a ${count} en importación ${importacion_id}`);
    }

    return res.json({
      ok: true,
      resumen: {
        archivo:              nombreArchivo,
        tipo,
        transacciones:        insertados,
        total_ingresos:       totalIngresos,
        total_egresos:        totalEgresos,
        tiempo_ms:            tiempoMs,
        duplicados_eliminados: reconciliacion.eliminadas,
      },
      ejemplo_transaccion: registros[0] || null,
    });

  } catch (err) {
    console.error('[documentos] Error:', err.message);

    // Marcar importacion como fallida
    if (importacion_id) {
      await supabase
        .from('importaciones_historicas')
        .update({
          estado:          'error',
          error_mensaje:   err.message,
          fecha_fin_procesamiento: new Date().toISOString(),
        })
        .eq('id', importacion_id)
        .catch(() => {});
    }

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ─── GET /api/documents/results/:empresa_id ──────────────────────────────────
// Retorna todas las transacciones agrupadas por categoría con totales.
// Usado por Lovable para construir el Estado de Resultados.
router.get('/results/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;
  const { desde, hasta, estado } = req.query;

  const supabase = getSupabase();

  try {
    // ── Construir query base ──────────────────────────────────────────────────
    let query = supabase
      .from('transacciones_historicas')
      .select('tipo, monto_original, categoria_sugerida_ia, confianza_deteccion, fecha_transaccion, descripcion_original, estado, id')
      .eq('empresa_id', empresa_id)
      .order('fecha_transaccion', { ascending: true });

    if (desde) query = query.gte('fecha_transaccion', desde);
    if (hasta) query = query.lte('fecha_transaccion', hasta);
    if (estado) query = query.eq('estado', estado);

    const { data: transacciones, error } = await query;

    if (error) throw new Error(error.message);
    if (!transacciones || transacciones.length === 0) {
      return res.json({
        ok: true,
        empresa_id,
        total_transacciones: 0,
        resumen: { total_ingresos: 0, total_egresos: 0, resultado_neto: 0 },
        ingresos: { total: 0, categorias: [] },
        egresos:  { total: 0, categorias: [] },
        transacciones: [],
      });
    }

    // ── Agrupar por categoría ─────────────────────────────────────────────────
    const grupos = {};
    let totalIngresos = 0;
    let totalEgresos  = 0;

    for (const t of transacciones) {
      const cat = t.categoria_sugerida_ia || (t.tipo === 'ingreso' ? 'otros_ingresos' : 'otros_gastos');
      if (!grupos[cat]) {
        grupos[cat] = {
          categoria:     cat,
          tipo:          t.tipo,
          total:         0,
          transacciones: 0,
          confianza_promedio: 0,
          _conf_sum: 0,
          _conf_count: 0,
        };
      }
      grupos[cat].total         += Number(t.monto_original);
      grupos[cat].transacciones += 1;
      if (t.confianza_deteccion) {
        grupos[cat]._conf_sum   += Number(t.confianza_deteccion);
        grupos[cat]._conf_count += 1;
      }

      if (t.tipo === 'ingreso') totalIngresos += Number(t.monto_original);
      else                      totalEgresos  += Number(t.monto_original);
    }

    // Calcular confianza promedio y limpiar campos internos
    const categorias = Object.values(grupos).map(g => {
      const confianza = g._conf_count > 0
        ? Math.round((g._conf_sum / g._conf_count) * 100)
        : null;
      const { _conf_sum, _conf_count, ...rest } = g;
      return { ...rest, confianza_promedio_pct: confianza };
    });

    const ingresos = categorias
      .filter(c => c.tipo === 'ingreso')
      .sort((a, b) => b.total - a.total);

    const egresos = categorias
      .filter(c => c.tipo === 'egreso')
      .sort((a, b) => b.total - a.total);

    return res.json({
      ok: true,
      empresa_id,
      periodo: { desde: desde || null, hasta: hasta || null },
      total_transacciones: transacciones.length,
      resumen: {
        total_ingresos:  Math.round(totalIngresos),
        total_egresos:   Math.round(totalEgresos),
        resultado_neto:  Math.round(totalIngresos - totalEgresos),
      },
      ingresos: {
        total:     Math.round(totalIngresos),
        categorias: ingresos,
      },
      egresos: {
        total:     Math.round(totalEgresos),
        categorias: egresos,
      },
    });

  } catch (err) {
    console.error('[results] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/documents/status ────────────────────────────────────────────────
// Endpoint para polling del frontend: consulta estado de UNA importación específica.
// Filtra por empresa del token (seguro). NO usa :empresa_id en path.
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { empresa_id } = req.auth;
    const { importacion_id, storage_path } = req.query;

    if (!importacion_id && !storage_path) {
      return res.status(400).json({
        ok: false,
        error: 'Se requiere importacion_id o storage_path como query param'
      });
    }

    const supabase = getSupabase();

    let query = supabase
      .from('importaciones_historicas')
      .select('id, estado, total_transacciones, total_ingresos, total_egresos, fecha_fin_procesamiento, error_mensaje, storage_path')
      .eq('empresa_id', empresa_id);

    if (importacion_id) {
      query = query.eq('id', importacion_id);
    } else {
      query = query.eq('storage_path', storage_path);
    }

    // Tomar la más reciente si hay múltiples (caso edge)
    query = query.order('created_at', { ascending: false }).limit(1).maybeSingle();

    const { data, error } = await query;

    if (error) {
      console.error('[/status] Error consultando importación:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data) {
      return res.status(404).json({ ok: false, error: 'Importación no encontrada' });
    }

    return res.json({
      ok: true,
      estado: data.estado,
      total_transacciones: data.total_transacciones || 0,
      total_ingresos: data.total_ingresos || 0,
      total_egresos: data.total_egresos || 0,
      fecha_fin_procesamiento: data.fecha_fin_procesamiento,
      error_mensaje: data.error_mensaje,
      storage_path: data.storage_path
    });
  } catch (err) {
    console.error('[/status] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/documents/status/:empresa_id ───────────────────────────────────
// Retorna el estado actual del procesamiento y un resumen de la última importación.
router.get('/status/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;
  const supabase = getSupabase();

  try {
    // ── Última importación ────────────────────────────────────────────────────
    const { data: importaciones, error: impErr } = await supabase
      .from('importaciones_historicas')
      .select('id, nombre_archivo, estado, fecha_subida, fecha_fin_procesamiento, total_transacciones, total_ingresos, total_egresos, error_mensaje')
      .eq('empresa_id', empresa_id)
      .order('fecha_subida', { ascending: false })
      .limit(1);

    if (impErr) throw new Error(impErr.message);

    const ultimaImportacion = importaciones?.[0] || null;
    const procesando = ultimaImportacion?.estado === 'procesando' ||
                       ultimaImportacion?.estado === 'pendiente';

    // ── Totales históricos ────────────────────────────────────────────────────
    const { data: totales, error: totErr } = await supabase
      .from('transacciones_historicas')
      .select('fecha_transaccion')
      .eq('empresa_id', empresa_id)
      .order('fecha_transaccion', { ascending: true });

    if (totErr) throw new Error(totErr.message);

    const totalTransacciones = totales?.length || 0;
    const primerRegistro = totales?.[0]?.fecha_transaccion || null;
    const ultimoRegistro = totales?.[totalTransacciones - 1]?.fecha_transaccion || null;

    // ── Construir respuesta ───────────────────────────────────────────────────
    return res.json({
      ok: true,
      empresa_id,
      procesando,
      ultima_importacion: ultimaImportacion
        ? {
            id:                       ultimaImportacion.id,
            fecha:                    (ultimaImportacion.fecha_fin_procesamiento || ultimaImportacion.fecha_subida || '').split('T')[0],
            archivo:                  ultimaImportacion.nombre_archivo,
            estado:                   ultimaImportacion.estado,
            transacciones_procesadas: ultimaImportacion.total_transacciones || 0,
            total_ingresos:           ultimaImportacion.total_ingresos || 0,
            total_egresos:            ultimaImportacion.total_egresos || 0,
            error:                    ultimaImportacion.error_mensaje || null,
          }
        : null,
      total_transacciones: totalTransacciones,
      primer_registro:     primerRegistro,
      ultimo_registro:     ultimoRegistro,
    });

  } catch (err) {
    console.error('[status] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/documents/upload-path ──────────────────────────────────────────
// Retorna la ruta base que el frontend debe usar al subir un archivo a Storage.
// Patrón: {user_id}/{timestamp}
// Requiere Authorization: Bearer <token de Supabase>
router.get('/upload-path', authMiddleware, (req, res) => {
  const { user_id } = req.auth;
  const timestamp   = Date.now();
  const path        = `${user_id}/${timestamp}`;

  console.log(`[WEBHOOK] upload-path generado para user_id='${user_id}': '${path}'`);

  return res.json({
    ok:   true,
    path,
    user_id,
  });
});

// ─── DELETE /api/documents/:empresa_id/importacion ───────────────────────────
// Elimina una importación junto con todas sus transacciones asociadas.
// Body: { importacion_id: string }
// Requiere Authorization: Bearer <token de Supabase>
router.delete('/:empresa_id/importacion', authMiddleware, async (req, res) => {
  const { empresa_id } = req.params;
  const { importacion_id } = req.body;

  if (req.auth.empresa_id !== empresa_id) {
    return res.status(403).json({ ok: false, error: 'Sin autorización para esta empresa' });
  }

  if (!importacion_id) {
    return res.status(400).json({ ok: false, error: 'Falta campo requerido: importacion_id' });
  }

  const supabase = getSupabase();

  try {
    // 1. Verificar que la importación existe y pertenece a esta empresa
    const { data: importacion, error: findErr } = await supabase
      .from('importaciones_historicas')
      .select('id, nombre_archivo')
      .eq('id', importacion_id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (findErr) throw new Error(findErr.message);

    if (!importacion) {
      // Idempotente: si ya no existe, OK
      return res.json({ ok: true, mensaje: 'Importación no encontrada, nada que eliminar' });
    }

    // 2. Eliminar todas las transacciones asociadas a esta importación
    const { error: txErr } = await supabase
      .from('transacciones_historicas')
      .delete()
      .eq('importacion_id', importacion_id);

    if (txErr) throw new Error(txErr.message);

    // 3. Eliminar el registro de importación
    const { error: impErr } = await supabase
      .from('importaciones_historicas')
      .delete()
      .eq('id', importacion_id);

    if (impErr) throw new Error(impErr.message);

    console.log(`[delete-importacion] ✓ Eliminada importación ${importacion_id} (${importacion.nombre_archivo}) para empresa ${empresa_id}`);

    return res.json({ ok: true, eliminado: { importacion_id } });

  } catch (err) {
    console.error('[delete-importacion] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/documents/test ──────────────────────────────────────────────────
router.get('/test', (_req, res) => {
  res.json({
    ok: true,
    message: 'Motor de procesamiento de documentos listo',
    tipos_soportados: ['excel', 'csv', 'pdf'],
    endpoints: {
      procesar:             'POST   /api/documents/process',
      resultados:           'GET    /api/documents/results/:empresa_id',
      estado:               'GET    /api/documents/status/:empresa_id',
      upload_path:          'GET    /api/documents/upload-path',
      delete_importacion:   'DELETE /api/documents/:empresa_id/importacion',
      webhook:              'POST   /api/webhooks/storage',
    },
  });
});

module.exports = router;
