const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { procesarExcel } = require('../services/documentProcessor/excelProcessor');
const { procesarPDF } = require('../services/documentProcessor/pdfProcessor');
const { categorizarTransacciones } = require('../services/documentProcessor/aiCategorizer');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function detectarTipo(nombreArchivo) {
  const ext = (nombreArchivo || '').split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (ext === 'csv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  return null;
}

// ─── Resolver user_id desde el path del archivo ──────────────────────────────
// El bucket 'documentos' usa el patrón: {user_id}/{timestamp}/{nombre_archivo}
// El primer segmento del path es el auth.uid() del usuario — no el empresa_id.
function resolverUserId(filePath) {
  return (filePath || '').split('/')[0] || null;
}

// ─── Procesamiento asíncrono del documento ────────────────────────────────────
async function procesarDocumento({ supabase, empresaId, bucketName, filePath, importacionId }) {
  const inicio = Date.now();
  const nombreArchivo = filePath.split('/').pop();

  try {
    // 1. Marcar como procesando
    await supabase
      .from('importaciones_historicas')
      .update({
        estado: 'procesando',
        fecha_inicio_procesamiento: new Date().toISOString(),
      })
      .eq('id', importacionId);

    // 2. Descargar archivo desde Storage
    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from(bucketName)
      .download(filePath);

    if (downloadError) throw new Error(`Error descargando archivo: ${downloadError.message}`);

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const tipo = detectarTipo(nombreArchivo);

    if (!tipo) throw new Error(`Tipo no soportado: ${nombreArchivo}. Use Excel, CSV o PDF.`);

    console.log(`[webhook] Procesando ${nombreArchivo} (${tipo}) para empresa ${empresaId}`);

    // 3. Extraer transacciones según tipo
    let transacciones;
    if (tipo === 'excel' || tipo === 'csv') {
      transacciones = procesarExcel(buffer, nombreArchivo);
    } else {
      transacciones = await procesarPDF(buffer);
    }

    console.log(`[webhook] Extraídas ${transacciones.length} transacciones`);

    // 4. Categorizar con IA
    console.log('[webhook] Categorizando con Claude...');
    const categorizadas = await categorizarTransacciones(transacciones);
    console.log('[webhook] Categorización completada');

    // 5. Preparar registros (descartar transacciones con monto inválido)
    const registros = categorizadas.flatMap(t => {
      const monto = typeof t.monto_original === 'number' ? t.monto_original : parseFloat(t.monto_original);
      if (isNaN(monto)) {
        console.log('[webhook] descartando registro con monto inválido:', JSON.stringify({ desc: t.descripcion_original, monto_raw: t.monto_original }));
        return [];
      }
      return [{
        empresa_id:              empresaId,
        importacion_id:          importacionId,
        fecha_transaccion:       t.fecha_transaccion,
        descripcion_original:    t.descripcion_original,
        descripcion_normalizada: t.descripcion_normalizada,
        numero_documento:        t.numero_documento || null,
        tipo:                    t.tipo,
        monto_original:          monto,
        saldo_posterior:         t.saldo_posterior || null,
        moneda_original:         t.moneda_original || 'CLP',
        categoria_sugerida_ia:   t.categoria_sugerida_ia || null,
        confianza_deteccion:     t.confianza_deteccion != null
                                   ? Math.min(0.999, Math.max(0, t.confianza_deteccion > 1 ? t.confianza_deteccion / 100 : t.confianza_deteccion))
                                   : null,
        estado:                  'pendiente_revision',
        fuente:                  t.fuente || 'cartola_banco',
        archivo_origen:          nombreArchivo,
      }];
    });

    // 6. Insertar uno a uno verificando duplicados (conteo PDF vs BD)
    let insertados = 0;
    let duplicados = 0;
    for (const registro of registros) {
      const ocurrenciasEnPDF = contarOcurrenciasEnLote(registros, registro);
      const ocurrenciasEnBD  = await contarTransaccionesEnBD(supabase, empresaId, registro);

      // Si BD ya tiene tantas como el PDF dice, es duplicado
      if (ocurrenciasEnBD >= ocurrenciasEnPDF) {
        duplicados++;
        continue;
      }

      const { error } = await supabase.from('transacciones_historicas').insert([registro]);
      if (error) {
        console.log('[webhook] falla registro:', registro.fecha_transaccion, registro.descripcion_original);
        console.log('[webhook] error:', error.message);
      } else {
        insertados++;
      }
    }
    if (duplicados > 0) console.log(`[WEBHOOK] ${duplicados} transacciones duplicadas omitidas`);

    // 7. Calcular totales
    const totalIngresos = registros
      .filter(r => r.tipo === 'ingreso')
      .reduce((s, r) => s + r.monto_original, 0);
    const totalEgresos = registros
      .filter(r => r.tipo === 'egreso')
      .reduce((s, r) => s + r.monto_original, 0);

    // 8. Actualizar importacion como completada
    await supabase
      .from('importaciones_historicas')
      .update({
        estado:                  'completado',
        total_transacciones:     insertados,
        total_ingresos:          Math.round(totalIngresos),
        total_egresos:           Math.round(totalEgresos),
        fecha_fin_procesamiento: new Date().toISOString(),
        tiempo_procesamiento_ms: Date.now() - inicio,
      })
      .eq('id', importacionId);

    console.log(`[webhook] ✓ ${insertados} transacciones guardadas para empresa ${empresaId} en ${Date.now() - inicio}ms`);

  } catch (err) {
    console.error('[webhook] Error procesando documento:', err.message);

    try {
      await supabase
        .from('importaciones_historicas')
        .update({
          estado:                  'error',
          error_mensaje:           err.message,
          fecha_fin_procesamiento: new Date().toISOString(),
        })
        .eq('id', importacionId);
    } catch (_) {
      // best-effort — no interrumpir si este update también falla
    }
  }
}

// ─── Validación anti-duplicados a nivel de transacción ───────────────────────

// Cuenta cuántas transacciones idénticas existen ya en BD.
// Maneja correctamente numero_documento = null (usa .is() no .eq())
async function contarTransaccionesEnBD(supabase, empresaId, tx) {
  let query = supabase
    .from('transacciones_historicas')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresaId)
    .eq('fecha_transaccion', tx.fecha_transaccion)
    .eq('monto_original', tx.monto_original)
    .eq('tipo', tx.tipo);

  // CRÍTICO: cuando docto es null/undefined, usar .is('numero_documento', null)
  // .eq() con null no funciona en Postgres (SQL: NULL = NULL es false)
  if (tx.numero_documento) {
    query = query.eq('numero_documento', tx.numero_documento);
  } else {
    query = query.is('numero_documento', null);
  }

  const { count, error } = await query;
  if (error) {
    console.error('[contarTransaccionesEnBD] Error:', error.message);
    return 0; // en caso de error, asumir 0 (insertar) para no perder datos
  }
  return count || 0;
}

// Wrapper para compatibilidad: devuelve true si hay al menos 1 en BD (legacy)
async function esTransaccionDuplicada(supabase, empresaId, tx) {
  const count = await contarTransaccionesEnBD(supabase, empresaId, tx);
  return count > 0;
}

// Helper: cuenta cuántas veces aparece una tx idéntica en el lote (PDF)
function contarOcurrenciasEnLote(lote, tx) {
  return lote.filter(r =>
    r.fecha_transaccion === tx.fecha_transaccion &&
    r.monto_original === tx.monto_original &&
    r.tipo === tx.tipo &&
    (r.numero_documento || null) === (tx.numero_documento || null)
  ).length;
}

// ─── POST /api/webhooks/storage ───────────────────────────────────────────────
// Disparado por Supabase Database Webhook cuando se inserta en storage.objects.
// Configura el webhook en: Supabase → Database → Webhooks → New Webhook
//   Table:  storage.objects
//   Events: INSERT
//   URL:    https://tu-backend.com/api/webhooks/storage
//   HTTP Headers: { "x-webhook-secret": "<WEBHOOK_SECRET>" }
router.post('/storage', async (req, res) => {
  // ── Verificar secret ────────────────────────────────────────────────────────
  const secret = req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Secret inválido' });
  }

  const payload = req.body;

  // ── Validar que es un INSERT en storage.objects ─────────────────────────────
  if (payload.type !== 'INSERT' || payload.table !== 'objects') {
    return res.json({ ok: true, ignorado: true, razon: 'No es un INSERT en storage.objects' });
  }

  const record = payload.record || {};
  const bucketName  = record.bucket_id;
  const filePath    = record.name;    // e.g. "{user_id}/{timestamp}/cartola_abril.xlsx"
  const ownerUserId = record.owner;   // auth.uid() del usuario que subió el archivo

  // Ignorar buckets que no sean de documentos
  const BUCKETS_ACEPTADOS = (process.env.STORAGE_BUCKETS || 'documentos').split(',');
  if (!BUCKETS_ACEPTADOS.includes(bucketName)) {
    return res.json({ ok: true, ignorado: true, razon: `Bucket '${bucketName}' no procesado` });
  }

  // Ignorar archivos con extensión no soportada
  const tipo = detectarTipo(filePath);
  if (!tipo) {
    return res.json({ ok: true, ignorado: true, razon: `Extensión no soportada: ${filePath}` });
  }

  const supabase = getSupabase();

  // ── Resolver user_id (primer segmento del path o record.owner) ─────────────
  // Preferimos record.owner (garantizado por Supabase Storage) y usamos el
  // primer segmento del path como fallback.
  const userId = ownerUserId || resolverUserId(filePath);
  console.log(`[WEBHOOK] user_id extraído: '${userId}' (owner='${ownerUserId}', path='${filePath}')`);

  if (!userId) {
    console.error(`[WEBHOOK] No se pudo determinar el user_id — path: '${filePath}'`);
    return res.status(422).json({
      ok: false,
      error: 'No se pudo determinar el usuario. El archivo debe estar en una carpeta con el user_id.',
    });
  }

  // ── Buscar empresa_id en la tabla empresas usando owner_id ─────────────────
  // El storage path usa auth.uid() como primer segmento, no el empresa_id.
  const { data: empresa, error: empresaErr } = await supabase
    .from('empresas')
    .select('id')
    .eq('owner_id', userId)
    .maybeSingle();

  if (empresaErr) {
    console.error(`[WEBHOOK] Error consultando empresa para user_id '${userId}':`, empresaErr.message);
    return res.status(500).json({ ok: false, error: empresaErr.message });
  }

  if (!empresa) {
    console.log(`[WEBHOOK] empresa NO encontrada para user_id '${userId}' — path: '${filePath}' — ignorando evento`);
    return res.json({ ok: true, ignorado: true, razon: `No existe empresa para user_id '${userId}'` });
  }

  const empresaRealId = empresa.id;
  console.log(`[WEBHOOK] empresa encontrada para user_id '${userId}': empresa_id='${empresaRealId}'`);

  const nombreArchivo = filePath.split('/').pop();
  // Nombre limpio: elimina prefijo de timestamp (ej: "1777458613943-Cartola Scotiabank.pdf" → "Cartola Scotiabank.pdf")
  const nombreLimpio = nombreArchivo.replace(/^\d+-/, '');

  // ── Buscar registro existente creado por el frontend ───────────────────────
  const { data: existente } = await supabase
    .from('importaciones_historicas')
    .select('id, estado')
    .eq('empresa_id', empresaRealId)
    .eq('nombre_archivo', nombreLimpio)
    .in('estado', ['pendiente', 'subiendo'])
    .order('fecha_subida', { ascending: false })
    .limit(1)
    .maybeSingle();

  let importacionId;

  if (existente) {
    // Encontrado: actualizar storage_path y reusar el id del frontend
    console.log(`[WEBHOOK] registro existente encontrado (id=${existente.id}), actualizando storage_path`);
    await supabase
      .from('importaciones_historicas')
      .update({ archivo_path: filePath, storage_path: filePath })
      .eq('id', existente.id);
    importacionId = existente.id;
  } else {
    // Caso edge: frontend no creó registro, crear uno nuevo
    console.log(`[WEBHOOK] sin registro previo para '${nombreLimpio}', creando nuevo`);
    const { data: nuevo, error: importErr } = await supabase
      .from('importaciones_historicas')
      .insert({
        empresa_id:      empresaRealId,
        nombre_archivo:  nombreLimpio,
        archivo_path:    filePath,
        storage_path:    filePath,
        bucket_name:     bucketName,
        estado:          'pendiente',
        fecha_subida:    new Date().toISOString(),
      })
      .select('id')
      .single();

    if (importErr) {
      console.error('[webhook] Error creando importacion:', importErr.message);
      return res.status(500).json({ ok: false, error: importErr.message });
    }
    importacionId = nuevo.id;
  }

  // ── Responder inmediatamente y procesar en background ──────────────────────
  res.json({
    ok: true,
    mensaje: 'Archivo recibido, procesando en background',
    importacion_id: importacionId,
    empresa_id:     empresaRealId,
    archivo:        nombreArchivo,
  });

  // Procesar sin bloquear la respuesta HTTP
  setImmediate(() => {
    procesarDocumento({
      supabase,
      empresaId:     empresaRealId,
      bucketName,
      filePath,
      importacionId,
    });
  });
});

module.exports = router;
module.exports.esTransaccionDuplicada    = esTransaccionDuplicada;
module.exports.contarTransaccionesEnBD   = contarTransaccionesEnBD;
module.exports.contarOcurrenciasEnLote   = contarOcurrenciasEnLote;
