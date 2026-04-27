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

// ─── Resolver empresa_id desde el path del archivo ───────────────────────────
// El bucket 'documentos' usa el patrón: {empresa_id}/{fecha}/{nombre_archivo}
// El primer segmento del path es directamente el empresa_id — no hay lookup.
function resolverEmpresaId(filePath) {
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

    // 6. Insertar uno a uno para identificar el registro que falla
    let insertados = 0;
    for (const registro of registros) {
      const { error } = await supabase.from('transacciones_historicas').insert([registro]);
      if (error) {
        console.log('[webhook] falla registro:', JSON.stringify({ monto: registro.monto_original, confianza: registro.confianza_deteccion, desc: registro.descripcion_original }));
        console.log('[webhook] error:', error.message);
      } else {
        insertados++;
      }
    }

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
  const bucketName = record.bucket_id;
  const filePath   = record.name;       // e.g. "empresa-123/cartola_abril.xlsx"
  const ownerUserId = record.owner;

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

  // ── Resolver empresa_id ─────────────────────────────────────────────────────
  const empresaId = resolverEmpresaId(filePath);
  console.log(`[webhook] empresa_id extraído del path: '${empresaId}' (path completo: '${filePath}')`);

  if (!empresaId) {
    console.error(`[webhook] No se pudo extraer empresa_id del path: ${filePath}`);
    return res.status(422).json({
      ok: false,
      error: 'No se pudo determinar la empresa. El archivo debe estar en una carpeta con el empresa_id.',
    });
  }

  // ── Verificar que el empresa_id existe en la tabla empresas ────────────────
  // El primer segmento del path es directamente el id de la empresa.
  console.log('[webhook] empresaId raw:', JSON.stringify(empresaId), 'length:', empresaId.length);
  const { data: empresa, error: empresaErr } = await supabase
    .from('empresas')
    .select('id')
    .eq('id', empresaId)
    .maybeSingle();

  if (empresaErr) {
    console.error(`[webhook] Error consultando empresa '${empresaId}':`, empresaErr.message);
    return res.status(500).json({ ok: false, error: empresaErr.message });
  }

  if (!empresa) {
    console.log(`[webhook] empresa_id '${empresaId}' no existe en tabla empresas — path: '${filePath}' — ignorando evento`);
    return res.json({ ok: true, ignorado: true, razon: `empresa_id '${empresaId}' no existe en empresas` });
  }

  const empresaRealId = empresa.id;
  console.log(`[webhook] Empresa encontrada: id='${empresaRealId}'`);

  const nombreArchivo = filePath.split('/').pop();

  // ── Crear registro en importaciones_historicas ──────────────────────────────
  const { data: importacion, error: importErr } = await supabase
    .from('importaciones_historicas')
    .insert({
      empresa_id:      empresaRealId,
      nombre_archivo:  nombreArchivo,
      archivo_path:    filePath,
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

  // ── Responder inmediatamente y procesar en background ──────────────────────
  res.json({
    ok: true,
    mensaje: 'Archivo recibido, procesando en background',
    importacion_id: importacion.id,
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
      importacionId: importacion.id,
    });
  });
});

module.exports = router;
