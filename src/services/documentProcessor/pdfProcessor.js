// pdfProcessor.js — Pipeline de 3 pasos con pdf2json
//
// Paso 1 — Extracción pura: pdf2json entrega texto + líneas verticales (VLines)
// Paso 2 — Asignación de columna:
//   · Con VLines: fronteras exactas entre columnas (preferido)
//   · Sin VLines: distancia mínima al encabezado (cada elemento va a la columna
//                  cuyo x está más cerca del x del elemento)
// Paso 3 — Regla inviolable:
//           columna docto  → numero_documento (NUNCA monto)
//           columna cargos → tipo: 'egreso'   (NUNCA lo decide la IA)
//           columna abonos → tipo: 'ingreso'  (NUNCA lo decide la IA)
//
// Ver SKILL_CARTOLA.md para reglas completas de parsing.

const PDFParser = require('pdf2json');

// ─── Normalización de texto ───────────────────────────────────────────────────
function normText(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quitar tildes
    .replace(/[$.()]/g, '')            // ignorar puntuación
    .trim();
}

// ─── Parseo de montos en formato chileno (Reglas 5, 6, 8 de la skill) ────────
function parseMonto(s) {
  if (!s || !s.trim()) return null;
  let str = s.trim();
  // Notación contable: (150.000) → negativo → valor absoluto (Regla 8)
  if (str.startsWith('(') && str.endsWith(')')) str = str.slice(1, -1);
  const limpio   = str.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs      = limpio.replace('-', '');
  if (!abs || !/\d/.test(abs)) return null;

  const tienePoint = abs.includes('.');
  const tieneComa  = abs.includes(',');
  let num;

  if (tienePoint && tieneComa) {
    const lp = abs.lastIndexOf('.');
    const lc = abs.lastIndexOf(',');
    num = lc > lp
      ? parseFloat(abs.replace(/\./g, '').replace(',', '.'))   // formato chileno
      : parseFloat(abs.replace(/,/g, ''));                     // formato anglosajón
  } else if (tieneComa && !tienePoint) {
    const partes = abs.split(',');
    num = (partes.length === 2 && partes[1].length <= 2)
      ? parseFloat(abs.replace(',', '.'))
      : parseFloat(abs.replace(/,/g, ''));
  } else {
    // Regla 5: si todos los segmentos tras el primero tienen 3 dígitos → miles
    const partes = abs.split('.');
    const sonMiles = partes.length > 1 && partes.slice(1).every(p => p.length === 3);
    num = sonMiles ? parseFloat(abs.replace(/\./g, '')) : parseFloat(abs);
  }

  if (isNaN(num) || num < 0) return null;
  return Math.abs(num);
}

// ─── Patrones de fecha (Regla 7 de la skill) ─────────────────────────────────
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,   // DD/MM/YYYY o DD-MM-YYYY
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,   // YYYY-MM-DD
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,   // DD/MM/YY
];

function normalizarFecha(m, fmt) {
  if (fmt === 0) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (fmt === 1) return `${m[1]}-${m[2]}-${m[3]}`;
  if (fmt === 2) {
    const y = parseInt(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
}

function extraerFecha(texto) {
  for (let i = 0; i < FECHA_RE.length; i++) {
    const m = texto.match(FECHA_RE[i]);
    if (m) return normalizarFecha(m, i);
  }
  return null;
}

// ─── Aliases de columnas (Fase 1.1 de la skill) ──────────────────────────────
const COL_ALIASES = {
  fecha:       ['fecha', 'fec', 'fec.', 'dt.', 'f.', 'date'],
  descripcion: ['descripcion', 'narracion', 'glosa', 'concepto', 'detalle', 'movimiento', 'texto'],
  docto:       ['docto', 'n doc', 'ndoc', 'nro doc', 'nrodoc', 'documento', 'nro', 'n ref', 'referencia', 'ref', 'folio', 'n', 'num'],
  cargos:      ['cargo', 'cargos', 'debito', 'debitos', 'retiro', 'egreso', 'db', 'debitos', 'debit', 'debits'],
  abonos:      ['abono', 'abonos', 'credito', 'creditos', 'deposito', 'depositos', 'ingreso', 'cr', 'creditos', 'credit', 'credits'],
  saldo:       ['saldo', 'balance', 'saldo final', 'saldo disponible', 'saldo actual', 'sdo'],
};

// Filas a descartar aunque tengan fecha
const SKIP_DESC_RE = /^(saldo anterior|saldo inicial|total |subtotal|totales|resumen)\b/;

// Heurística de tipo por palabras clave (último fallback — nunca es el camino principal)
const KW_INGRESO = ['abono', 'deposito', 'transferencia recibida', 'credito', 'remuneracion', 'sueldo', 'devolucion'];
const KW_EGRESO  = ['pago', 'cargo', 'debito', 'retiro', 'cuota', 'comision', 'impuesto', 'compra', 'giro'];

function inferirTipo(desc) {
  const d = normText(desc);
  for (const kw of KW_INGRESO) { if (d.includes(kw)) return 'ingreso'; }
  for (const kw of KW_EGRESO)  { if (d.includes(kw)) return 'egreso'; }
  return 'egreso';
}

// ─── PASO 1: Extracción pura con pdf2json ─────────────────────────────────────
// Devuelve { pdfData } con la estructura completa incluyendo VLines.
function extraerDatosCrudos(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', data => resolve(data));
    parser.on('pdfParser_dataError', err =>
      reject(new Error(`pdf2json: ${err.parserError || JSON.stringify(err)}`))
    );
    parser.parseBuffer(buffer);
  });
}

// ─── Extraer items de texto de las páginas de pdf2json ────────────────────────
// Devuelve: [{ page, x, y, text }]
function extraerItems(pdfData) {
  const items = [];
  pdfData.Pages.forEach((page, pageIdx) => {
    for (const txt of (page.Texts || [])) {
      const text = txt.R
        .map(r => decodeURIComponent(r.T))
        .join('')
        .trim();
      if (text) {
        items.push({ page: pageIdx + 1, x: txt.x, y: txt.y, text });
      }
    }
  });
  return items;
}

// ─── PASO 2a: Detectar líneas verticales de la tabla ─────────────────────────
// Devuelve array de x ordenados (fronteras exactas) o [] si no hay VLines útiles.
function detectarVLines(pdfData, alturaMinima = 5) {
  const xs = [];
  for (const page of pdfData.Pages) {
    for (const vl of (page.VLines || [])) {
      // Solo líneas que cubran una altura significativa (son separadores de tabla)
      if ((vl.l || 0) >= alturaMinima) {
        xs.push(vl.x);
      }
    }
  }
  if (xs.length < 2) return [];

  // Deduplicar: agrupar xs muy cercanos (tolerancia 0.5 unidades) y tomar el promedio
  xs.sort((a, b) => a - b);
  const grupos = [[xs[0]]];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - grupos[grupos.length - 1][0] < 0.5) {
      grupos[grupos.length - 1].push(xs[i]);
    } else {
      grupos.push([xs[i]]);
    }
  }
  const fronteras = grupos.map(g => g.reduce((a, b) => a + b, 0) / g.length);
  console.log(`[PDF] VLines detectadas: ${fronteras.map(x => x.toFixed(2)).join(', ')}`);
  return fronteras;
}

// ─── PASO 2b: Agrupar items en filas (misma página + y similar) ───────────────
function agruparEnFilas(items, tolerancia = 0.4) {
  const mapa = [];
  for (const item of items) {
    const fila = mapa.find(
      f => f.page === item.page && Math.abs(f.y - item.y) <= tolerancia
    );
    if (fila) {
      fila.items.push({ x: item.x, text: item.text });
    } else {
      mapa.push({ page: item.page, y: item.y, items: [{ x: item.x, text: item.text }] });
    }
  }
  mapa.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);
  mapa.forEach(f => f.items.sort((a, b) => a.x - b.x));
  return mapa;
}

// ─── PASO 2c: Detectar fila de encabezado → colMap { col: x } ────────────────
function detectarEncabezado(filas) {
  for (let i = 0; i < filas.length; i++) {
    const fila   = filas[i];
    const colMap = {};

    for (const item of fila.items) {
      const norm = normText(item.text);
      for (const [col, aliases] of Object.entries(COL_ALIASES)) {
        if (colMap[col] !== undefined) continue;
        if (aliases.some(a => norm === a || norm.startsWith(a + ' ') || norm === a.replace(/ /g, ''))) {
          colMap[col] = item.x;
        }
      }
    }

    // Mínimo requerido: cargos + abonos (sin fecha también puede funcionar)
    if (colMap.cargos !== undefined && colMap.abonos !== undefined) {
      console.log(`[PDF] Encabezado detectado en fila ${i}:`, JSON.stringify(colMap));
      return { headerIdx: i, headerPage: fila.page, colMap };
    }
  }
  return null;
}

// ─── PASO 2d (modo VLines): crear zonas exactas por líneas verticales ────────
// Devuelve { col: { xMin, xMax } } usando las fronteras reales del PDF.
function crearZonasVLines(colMap, fronteras) {
  const zonas = {};
  for (const [col, cx] of Object.entries(colMap)) {
    let xMin = -Infinity;
    let xMax = Infinity;

    if (cx < fronteras[0]) {
      xMax = fronteras[0];
    } else if (cx >= fronteras[fronteras.length - 1]) {
      xMin = fronteras[fronteras.length - 1];
    } else {
      for (let i = 0; i < fronteras.length - 1; i++) {
        if (cx >= fronteras[i] && cx < fronteras[i + 1]) {
          xMin = fronteras[i];
          xMax = fronteras[i + 1];
          break;
        }
      }
    }
    zonas[col] = { xMin, xMax };
  }
  console.log('[PDF] Zonas por VLines:', JSON.stringify(
    Object.fromEntries(Object.entries(zonas).map(([c, z]) => [c, `[${isFinite(z.xMin) ? z.xMin.toFixed(2) : '-∞'}, ${isFinite(z.xMax) ? z.xMax.toFixed(2) : '+∞'})`]))
  ));
  return zonas;
}

// ─── Asignar items a columna por zona (modo VLines) ──────────────────────────
function asignarPorZona(fila, zonas) {
  const celdas = {};
  for (const item of fila.items) {
    for (const [col, { xMin, xMax }] of Object.entries(zonas)) {
      if (item.x >= xMin && item.x < xMax) {
        celdas[col] = ((celdas[col] || '') + ' ' + item.text).trim();
        break;
      }
    }
  }
  return celdas;
}

// ─── PASO 2d (fallback sin VLines): distancia mínima al encabezado ────────────
// Cada elemento de texto se asigna a la columna cuyo x del encabezado está
// más cerca del x del elemento. Regla: docto → documento, cargos → egreso,
// abonos → ingreso. La IA no interviene en esta decisión.
//
// Ejemplo (datos reales Scotiabank):
//   elemento x=18.132, docto=18.597, cargos=22.169
//   → dist a docto=0.465, dist a cargos=4.037 → asignado a docto ✓
//
//   elemento x=23.002, cargos=22.169, abonos=25.756
//   → dist a cargos=0.833, dist a abonos=2.754 → asignado a cargos ✓
function asignarPorDistancia(fila, colMap) {
  const cols = Object.entries(colMap);  // [[col, x_encabezado], ...]
  const celdas = {};

  for (const item of fila.items) {
    let nearestCol = null;
    let minDist    = Infinity;
    for (const [col, cx] of cols) {
      const dist = Math.abs(item.x - cx);
      if (dist < minDist) {
        minDist    = dist;
        nearestCol = col;
      }
    }
    if (nearestCol) {
      celdas[nearestCol] = ((celdas[nearestCol] || '') + ' ' + item.text).trim();
    }
  }

  return celdas;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────
async function parsearPDF(buffer) {
  // Paso 1: Extracción pura
  const pdfData = await extraerDatosCrudos(buffer);

  // Paso 2a: Líneas verticales
  const fronteras = detectarVLines(pdfData);

  // Extraer texto
  const items = extraerItems(pdfData);
  console.log(`[PDF] Items de texto extraídos: ${items.length}`);

  if (items.length === 0) {
    throw new Error('El PDF no contiene texto seleccionable. Use un PDF generado digitalmente, no escaneado.');
  }

  // Paso 2b: Agrupar en filas
  const filas = agruparEnFilas(items);
  console.log(`[PDF] Filas agrupadas: ${filas.length}`);

  // Paso 2c: Detectar encabezado
  const header = detectarEncabezado(filas);
  if (!header) {
    // Log filas para diagnóstico
    console.log('[PDF] No se detectó encabezado. Primeras 15 filas:');
    filas.slice(0, 15).forEach((f, i) => {
      const texto = f.items.map(it => `[x${it.x.toFixed(1)}]"${it.text}"`).join(' ');
      console.log(`  [${i}] p${f.page} y=${f.y.toFixed(2)} → ${texto}`);
    });
    return [];
  }

  // Paso 2d: Determinar método de asignación de columna
  const usaVLines = fronteras.length >= 2;
  const zonas     = usaVLines ? crearZonasVLines(header.colMap, fronteras) : null;

  if (!usaVLines) {
    console.log('[PDF] Sin VLines → usando distancia mínima al encabezado (colMap):', JSON.stringify(header.colMap));
  }

  const transacciones = [];
  let filaAnterior = null;  // para concatenar descripción multi-línea

  for (let i = header.headerIdx + 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila.page < header.headerPage) continue;

    // Paso 3: Asignar columna por zona (VLines) o por distancia mínima (fallback)
    // Regla inviolable: la posición del elemento determina su tipo, nunca la IA.
    const celdas = usaVLines
      ? asignarPorZona(fila, zonas)
      : asignarPorDistancia(fila, header.colMap);

    // ── Fecha (Regla 7) ──────────────────────────────────────────────────────
    const fechaTexto = (celdas.fecha || Object.values(celdas)[0] || '');
    const fecha = extraerFecha(fechaTexto);

    // Si no tiene fecha, puede ser continuación de descripción multi-línea
    if (!fecha) {
      if (filaAnterior && celdas.descripcion) {
        filaAnterior.descripcion_original += ' ' + celdas.descripcion.trim();
        filaAnterior.descripcion_normalizada = filaAnterior.descripcion_original
          .toLowerCase().replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    // ── Descripción (Regla 9) ────────────────────────────────────────────────
    let descripcion = (celdas.descripcion || '').trim();
    if (descripcion.length < 3) continue;
    if (SKIP_DESC_RE.test(normText(descripcion))) continue;

    // ── Número de documento (Regla 1: NUNCA es monto) ───────────────────────
    const textoDocto      = (celdas.docto || '').trim();
    const mDocto          = textoDocto.match(/[\w][\w\-]*/);
    const numero_documento = mDocto ? mDocto[0] : null;

    // ── PASO 3 — Regla inviolable: zona → tipo ───────────────────────────────
    // La IA NUNCA decide esto. Solo la posición de la columna.
    const vCargo = parseMonto(celdas.cargos || '');
    const vAbono = parseMonto(celdas.abonos || '');

    let cargo = 0;
    let abono = 0;
    let monto = null;
    let tipo  = null;

    if (vCargo && vCargo > 0) {
      cargo = vCargo;
      monto = vCargo;
      tipo  = 'egreso';   // zona Cargos → egreso (siempre)
    } else if (vAbono && vAbono > 0) {
      abono = vAbono;
      monto = vAbono;
      tipo  = 'ingreso';  // zona Abonos → ingreso (siempre)
    } else {
      // Fallback: ningún monto en columnas específicas — buscar cualquier número
      // y usar heurística de palabras clave (último recurso)
      for (const col of ['cargos', 'abonos', 'saldo']) {
        const v = parseMonto(celdas[col] || '');
        if (v && v > 0) {
          monto = v;
          tipo  = inferirTipo(descripcion);
          if (tipo === 'egreso') cargo = v; else abono = v;
          break;
        }
      }
    }

    // ── Saldo posterior (Regla 4: el más a la derecha) ───────────────────────
    const saldo = parseMonto(celdas.saldo || '') || null;

    // ── Validación ────────────────────────────────────────────────────────────
    if (!monto || !tipo) continue;

    const tx = {
      // Campos que espera el downstream (documents.js / webhooks.js)
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      numero_documento,
      tipo,
      monto_original:          monto,
      saldo_posterior:         saldo,
      moneda_original:         'CLP',
      fuente:                  'cartola_banco',
      // Campos explícitos para auditoría (el usuario puede ver de dónde vino el monto)
      cargo,
      abono,
      saldo,
    };

    transacciones.push(tx);
    filaAnterior = tx;
  }

  return transacciones;
}

// ─── Exportación principal ────────────────────────────────────────────────────
async function procesarPDF(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('procesarPDF requiere un Buffer.');
  }

  const transacciones = await parsearPDF(buffer);

  if (transacciones.length === 0) {
    throw new Error(
      'No se encontraron transacciones en el PDF. ' +
      'Verifique que sea una cartola bancaria chilena con texto seleccionable ' +
      'y que contenga columnas Cargos/Débitos y Abonos/Créditos.'
    );
  }

  return transacciones;
}

module.exports = { procesarPDF };
