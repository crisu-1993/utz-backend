// Ver SKILL_CARTOLA.md para reglas completas de parsing.
//
// Extracción: pdfreader — da coordenadas {x, y} reales por elemento de texto,
// equivalente a pdfplumber en Python. No más heurísticas de caracteres.
//
// Arquitectura:
//   Fase 1 — Extraer items {page, x, y, text} del PDF con posicionamiento real
//   Fase 2 — Agrupar por fila (misma página + y similar) → tabla de filas
//   Fase 3 — Detectar fila de encabezado → colMap { columna: x_real }
//   Fase 4 — Para cada fila de datos: asignar cada item al colMap por x más cercana
//   Fase 5 — Parsear cada celda según su columna (Cargo→egreso, Abono→ingreso, etc.)

const { PdfReader } = require('pdfreader');

// ─── Normalización de texto ───────────────────────────────────────────────────
function normText(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Parseo de montos en formato chileno (Reglas 5, 6, 8) ────────────────────
function parseMonto(s) {
  if (!s || !s.trim()) return null;
  let str = s.trim();
  if (str.startsWith('(') && str.endsWith(')')) str = str.slice(1, -1); // Regla 8
  const limpio   = str.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs      = limpio.replace('-', '');
  if (!abs || !/\d/.test(abs)) return null;

  const contienePoint = abs.includes('.');
  const contieneComa  = abs.includes(',');
  let num;

  if (contienePoint && contieneComa) {
    const lp = abs.lastIndexOf('.');
    const lc = abs.lastIndexOf(',');
    num = lc > lp
      ? parseFloat(abs.replace(/\./g, '').replace(',', '.'))
      : parseFloat(abs.replace(/,/g, ''));
  } else if (contieneComa && !contienePoint) {
    const p = abs.split(',');
    num = (p.length === 2 && p[1].length <= 2)
      ? parseFloat(abs.replace(',', '.'))
      : parseFloat(abs.replace(/,/g, ''));
  } else {
    // Regla 5: todos los segmentos tras el primero con 3 dígitos → miles
    const p = abs.split('.');
    const sonMiles = p.length > 1 && p.slice(1).every(s => s.length === 3);
    num = sonMiles ? parseFloat(abs.replace(/\./g, '')) : parseFloat(abs);
  }

  if (isNaN(num) || num < 0) return null;
  return negativo ? -Math.abs(num) : Math.abs(num);
}

// ─── Patrones de fecha (Regla 7) ─────────────────────────────────────────────
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,
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
  fecha:       ['fecha', 'fec', 'fec.', 'dt.', 'f.'],
  descripcion: ['descripcion', 'narracion', 'glosa', 'concepto', 'detalle', 'movimiento', 'texto'],
  docto:       ['docto', 'n° doc', 'n°doc', 'nro. doc', 'nro.doc', 'documento', 'nro', 'n° ref', 'nº ref', 'referencia', 'ref', 'folio', 'n°', 'num'],
  cargos:      ['cargo', 'cargos', 'debito', 'debitos', 'retiro', 'egreso', 'db'],
  abonos:      ['abono', 'abonos', 'credito', 'creditos', 'deposito', 'depositos', 'ingreso', 'cr'],
  saldo:       ['saldo', 'balance', 'saldo final', 'saldo disponible', 'saldo actual', 'sdo'],
};

// Filas a descartar aunque tengan fecha
const SKIP_DESC_RE = /^(saldo anterior|saldo inicial|total |subtotal|totales|resumen)\b/;

// Heurística de tipo por palabras clave (último fallback)
const KW_INGRESO = ['abono', 'deposito', 'transferencia recibida', 'credito', 'remuneracion', 'sueldo', 'devolucion'];
const KW_EGRESO  = ['pago', 'cargo', 'debito', 'retiro', 'cuota', 'comision', 'impuesto', 'compra', 'giro'];
function inferirTipo(desc) {
  const d = normText(desc);
  for (const kw of KW_INGRESO) { if (d.includes(kw)) return 'ingreso'; }
  for (const kw of KW_EGRESO)  { if (d.includes(kw)) return 'egreso'; }
  return 'egreso';
}

// ─── FASE 1: Extraer items con posicionamiento real ───────────────────────────
function extraerItems(buffer) {
  return new Promise((resolve, reject) => {
    const items = [];   // { page, x, y, text }
    let paginaActual = 1;

    new PdfReader().parseBuffer(buffer, (err, item) => {
      if (err) return reject(new Error(`pdfreader error: ${err.message || err}`));
      if (!item) return resolve(items);           // fin del PDF
      if (item.page) paginaActual = item.page;   // nueva página
      if (item.text) {
        items.push({ page: paginaActual, x: item.x, y: item.y, text: item.text });
      }
    });
  });
}

// ─── FASE 2: Agrupar items en filas por página + y similar ───────────────────
function agruparEnFilas(items, tolerancia = 0.4) {
  // Clave de fila: "página_y_representativo"
  const mapa = [];  // [{ page, y, items: [{x, text}] }]

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

  // Ordenar: por página luego por y; dentro de cada fila, por x
  mapa.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);
  mapa.forEach(f => f.items.sort((a, b) => a.x - b.x));

  return mapa;
}

// ─── FASE 3: Detectar fila de encabezado → colMap { columna: x_real } ────────
function detectarEncabezado(filas) {
  for (let i = 0; i < filas.length; i++) {
    const fila   = filas[i];
    const colMap = {};

    for (const item of fila.items) {
      const norm = normText(item.text);
      for (const [col, aliases] of Object.entries(COL_ALIASES)) {
        if (colMap[col] !== undefined) continue;          // ya encontrada
        if (aliases.some(a => norm === a || norm.startsWith(a))) {
          colMap[col] = item.x;
        }
      }
    }

    // Mínimo requerido: fecha + cargos + abonos
    if (colMap.fecha !== undefined && colMap.cargos !== undefined && colMap.abonos !== undefined) {
      return { headerIdx: i, headerPage: fila.page, colMap };
    }
  }
  return null;
}

// ─── FASE 4: Asignar items de una fila a su columna más cercana ───────────────
// Cada item va al colMap cuya x está más próxima. Devuelve { col: texto_celda }.
function asignarColumnas(fila, colMap) {
  const cols   = Object.entries(colMap);  // [[col, x], ...]
  const celdas = {};

  for (const item of fila.items) {
    let nearestCol = null;
    let minDist    = Infinity;
    for (const [col, x] of cols) {
      const dist = Math.abs(item.x - x);
      if (dist < minDist) { minDist = dist; nearestCol = col; }
    }
    if (nearestCol) {
      celdas[nearestCol] = ((celdas[nearestCol] || '') + ' ' + item.text).trim();
    }
  }

  return celdas;
}

// ─── FASE 5: Parsear transacciones ───────────────────────────────────────────
async function parsearPDF(buffer) {
  // Fase 1
  const items = await extraerItems(buffer);

  // ── DEBUG TEMPORAL ─────────────────────────────────────────────────────────
  console.log('\n[PDF DEBUG] Total items extraídos por pdfreader:', items.length);
  console.log('[PDF DEBUG] Primeros 40 items {page, x, y, text}:');
  items.slice(0, 40).forEach((it, i) =>
    console.log(`  [${String(i).padStart(2,'0')}] p${it.page} x=${String(it.x).padStart(5)} y=${String(it.y).padStart(5)}  ${JSON.stringify(it.text)}`)
  );
  // ── FIN DEBUG ──────────────────────────────────────────────────────────────

  // Fase 2
  const filas = agruparEnFilas(items);

  // ── DEBUG TEMPORAL ─────────────────────────────────────────────────────────
  console.log(`\n[PDF DEBUG] Filas agrupadas: ${filas.length}`);
  console.log('[PDF DEBUG] Primeras 20 filas:');
  filas.slice(0, 20).forEach((f, i) => {
    const texto = f.items.map(it => `[x${it.x}] ${it.text}`).join('  ');
    console.log(`  [${String(i).padStart(2,'0')}] p${f.page} y=${f.y}  →  ${texto}`);
  });
  // ── FIN DEBUG ──────────────────────────────────────────────────────────────

  // Fase 3
  const header = detectarEncabezado(filas);

  // ── DEBUG TEMPORAL ─────────────────────────────────────────────────────────
  if (!header) {
    console.log('\n[PDF DEBUG] ✗ No se detectó encabezado.');
    console.log('[PDF DEBUG] Aliases buscados — fecha:', COL_ALIASES.fecha, '| cargos:', COL_ALIASES.cargos, '| abonos:', COL_ALIASES.abonos);
  } else {
    console.log(`\n[PDF DEBUG] ✓ Encabezado en fila ${header.headerIdx} (página ${header.headerPage}):`);
    console.log('  items:', filas[header.headerIdx].items.map(it => `[x${it.x}] "${it.text}"`).join('  '));
    console.log('  colMap:', header.colMap);
  }
  // ── FIN DEBUG ──────────────────────────────────────────────────────────────

  if (!header) return [];

  const transacciones = [];

  // Fase 4 + 5: iterar filas de datos (tras el encabezado)
  for (let i = header.headerIdx + 1; i < filas.length; i++) {
    const fila = filas[i];

    // Ignorar filas de páginas anteriores a la del encabezado (no debería pasar)
    if (fila.page < header.headerPage) continue;

    const celdas = asignarColumnas(fila, header.colMap);

    // Fecha (Regla 7)
    const fecha = extraerFecha(celdas.fecha || '');
    if (!fecha) continue;

    // Descripción (Regla 9: la celda ya viene limpia, sin montos)
    let descripcion = (celdas.descripcion || '').trim();
    if (descripcion.length < 3) continue;
    if (SKIP_DESC_RE.test(normText(descripcion))) continue;

    // Número de documento (Regla 1: texto, nunca monto)
    const textoDocto = (celdas.docto || '').trim();
    const mDocto     = textoDocto.match(/\w[\w\-]*/);
    const numeroDocumento = mDocto ? mDocto[0] : null;

    // Cargo → egreso (Regla 2)
    let monto = null;
    let tipo  = null;
    const vCargo = parseMonto(celdas.cargos || '');
    if (vCargo && vCargo > 0) { monto = vCargo; tipo = 'egreso'; }

    // Abono → ingreso (Regla 3)
    if (!monto) {
      const vAbono = parseMonto(celdas.abonos || '');
      if (vAbono && vAbono > 0) { monto = vAbono; tipo = 'ingreso'; }
    }

    // Fallback: algún número en la fila + tipo por descripción
    if (!monto) {
      for (const col of ['cargos', 'abonos', 'saldo']) {
        const v = parseMonto(celdas[col] || '');
        if (v && v > 0) { monto = v; tipo = inferirTipo(descripcion); break; }
      }
    }

    // Saldo posterior (Regla 4)
    const saldoPosterior = parseMonto(celdas.saldo || '');

    // Validación (Fase 4)
    if (!monto || !tipo) continue;

    transacciones.push({
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      numero_documento:        numeroDocumento,
      tipo,
      monto_original:          monto,
      saldo_posterior:         saldoPosterior,
      moneda_original:         'CLP',
      fuente:                  'cartola_banco',
    });
  }

  return transacciones;
}

// ─── Exportación principal ───────────────────────────────────────────────────
async function procesarPDF(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('procesarPDF requiere un Buffer.');
  }

  const transacciones = await parsearPDF(buffer);

  if (transacciones.length === 0) {
    throw new Error(
      'No se encontraron transacciones en el PDF. ' +
      'Verifique que sea una cartola bancaria chilena con texto seleccionable ' +
      'y que contenga columnas Fecha, Cargos y Abonos.'
    );
  }

  return transacciones;
}

module.exports = { procesarPDF };
