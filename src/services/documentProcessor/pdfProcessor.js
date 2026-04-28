// pdfProcessor.js — Protocolo Universal de Validación de Filas
//
// Extracción:
//   Paso 1 — pdf2json: texto + VLines (líneas verticales de la tabla)
//   Paso 2 — Asignación de columna:
//              · Con VLines → fronteras exactas
//              · Sin VLines → distancia mínima al encabezado
//
// Protocolo Universal (5 pasos, aplica a cualquier banco chileno):
//   P1 — Filtro fecha:        celdas.fecha debe matchear exactamente un formato válido
//   P2 — Filtro monto:        debe haber al menos un valor numérico > 0 en cargo/abono
//   P3 — Filtro descripción:  mínimo 3 chars, no solo números
//   P4 — Normalización monto: quitar puntos de miles, reemplazar coma decimal
//   P5 — Encabezado repetido: filas que contienen las palabras del encabezado → descartar
//
// Regla inviolable:
//   columna docto  → numero_documento (NUNCA monto)
//   columna cargos → tipo: 'egreso'   (NUNCA la IA)
//   columna abonos → tipo: 'ingreso'  (NUNCA la IA)
//
// Ver SKILL_CARTOLA.md y CARTOLA_BANCARIA.md para contexto completo.

'use strict';

const PDFParser = require('pdf2json');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTES Y ALIASES
// ═══════════════════════════════════════════════════════════════════════════════

// Aliases de columnas — normalizados (minúsculas, sin tildes, sin puntuación).
// normText() se aplica al texto del PDF antes de comparar, por eso no hacen falta
// versiones con acento ni mayúsculas.
const COL_ALIASES = {
  fecha:       ['fecha', 'date', 'fec', 'fec.', 'dt.', 'f.'],
  descripcion: ['descripcion', 'descripción', 'glosa', 'detalle', 'concepto',
                'movimiento', 'narracion', 'texto'],
  docto:       ['docto', 'docto.', 'documento', 'n°doc', 'n° doc', 'n doc',
                'ndoc', 'referencia', 'nro', 'nro.', 'nro doc', 'nrodoc',
                'folio', 'n°', 'n ref', 'ref', 'num', 'comprobante'],
  cargos:      ['cargo', 'cargos', 'debito', 'debitos', 'monto debito',
                'retiro', 'egreso', 'db', 'debit', 'debits'],
  abonos:      ['abono', 'abonos', 'credito', 'creditos', 'monto credito',
                'deposito', 'depositos', 'ingreso', 'cr', 'credit', 'credits'],
  saldo:       ['saldo', 'saldo final', 'balance', 'saldo disponible',
                'saldo actual', 'sdo'],
};

// P1 — Formatos de fecha válidos (match exacto sobre celdas.fecha.trim())
const FORMATOS_FECHA = [
  /^\d{2}\/\d{2}\/\d{4}$/,   // 02/03/2026  — Scotiabank, BancoEstado, Itaú
  /^\d{2}-\d{2}-\d{4}$/,     // 02-03-2026  — Santander
  /^\d{2}\.\d{2}\.\d{4}$/,   // 02.03.2026  — algunos bancos
  /^\d{4}-\d{2}-\d{2}$/,     // 2026-03-02  — ISO / exportaciones
  /^\d{2}\/\d{2}\/\d{2}$/,   // 02/03/26    — BCI (año 2 dígitos)
];

// Filas con descripción que denotan totales/resumen (descartar aunque tengan fecha)
const SKIP_DESC_RE =
  /^(saldo anterior|saldo inicial|total |subtotal|totales|resumen)\b/;

// FIX-1: columna fecha solo acepta token con formato de fecha exacto
const FECHA_TOKEN_RE = /^\d{2}[\/\-\.]\d{2}[\/\-\.](\d{4}|\d{2})$/;

// FIX-2: columnas de monto solo aceptan tokens que sean números válidos
const MONTO_COLS = new Set(['cargos', 'abonos', 'saldo']);

// Palabras clave para inferir tipo (último fallback — rara vez se usa)
const KW_INGRESO = ['abono', 'deposito', 'transferencia recibida', 'credito',
                    'remuneracion', 'sueldo', 'devolucion'];
const KW_EGRESO  = ['pago', 'cargo', 'debito', 'retiro', 'cuota', 'comision',
                    'impuesto', 'compra', 'giro'];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS BÁSICOS
// ═══════════════════════════════════════════════════════════════════════════════

function normText(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // quitar tildes
    .replace(/[$.()°]/g, '')          // ignorar puntuación común
    .trim();
}

// P4 — Parser universal de montos chilenos.
//   · Quita puntos de miles:    1.443.707 → 1443707
//   · Reemplaza coma decimal:   1.443,70  → 1443.70
//   · Notación contable:        (150.000) → 150000
function parsearMonto(str) {
  if (!str) return null;
  let s = String(str).trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);  // valor absoluto
  const limpio = s
    .replace(/[$\s]/g, '')   // quitar $ y espacios
    .replace(/\./g, '')      // quitar separadores de miles
    .replace(',', '.');      // coma decimal → punto
  const num = parseFloat(limpio);
  return (isNaN(num) || num < 0) ? null : num;
}

// P1 — Valida que el string sea exactamente una fecha en formato conocido
function esFechaValida(str) {
  return FORMATOS_FECHA.some(re => re.test((str || '').trim()));
}

// P1 — Normaliza un string de fecha a ISO YYYY-MM-DD
function normalizarFecha(str) {
  const s = (str || '').trim();
  let m;
  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  m = s.match(/^(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  // DD/MM/YY
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) {
    const y = parseInt(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${y}-${m[2]}-${m[1]}`;
  }
  return null;
}

function inferirTipo(desc) {
  const d = normText(desc);
  for (const kw of KW_INGRESO) { if (d.includes(kw)) return 'ingreso'; }
  for (const kw of KW_EGRESO)  { if (d.includes(kw)) return 'egreso';  }
  return 'egreso';
}

// P5 — Devuelve true si la fila contiene las palabras del encabezado
//      (≥ 3 columnas distintas reconocidas → es un encabezado repetido)
function esEncabezadoRepetido(fila) {
  const encontradas = new Set();
  for (const item of fila.items) {
    const norm = normText(item.text);
    for (const [col, aliases] of Object.entries(COL_ALIASES)) {
      if (!encontradas.has(col) &&
          aliases.some(a => norm === a || norm.startsWith(a + ' '))) {
        encontradas.add(col);
      }
    }
    if (encontradas.size >= 3) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIXES DE ASIGNACIÓN (FIX-1 y FIX-2)
// ═══════════════════════════════════════════════════════════════════════════════

// FIX-2: verifica que un string represente un número válido.
// Acepta "1", "50", "1.490", "1.490,50" — rechaza "a", "b", fragmentos PDF.
function esNumeroValido(str) {
  const limpio = String(str)
    .replace(/[$\s]/g, '')   // quitar $ y espacios
    .replace(/\./g, '')      // quitar puntos de miles
    .replace(',', '.')       // coma decimal → punto
    .trim();
  const numero = parseFloat(limpio);
  return !isNaN(numero) && isFinite(numero);
}

// Decide la columna final para un elemento. Aplica:
//   FIX-1: si va a "fecha" pero no es formato de fecha → redirigir a "descripcion"
//   FIX-2: si va a columna de monto y no es número válido → descartar (artefacto PDF)
//   docto: siempre se guarda como string — nunca se filtra con esNumeroValido()
// Devuelve el nombre de columna definitivo, o null si hay que descartar.
function resolverColumna(col, texto, filaNum) {
  const txt = texto.trim();

  if (col === 'fecha' && !FECHA_TOKEN_RE.test(txt)) {
    console.log(`[PDF-FIX1] fecha corregida: "${txt}" reasignado a descripcion (fila ${filaNum})`);
    return 'descripcion';
  }

  if (MONTO_COLS.has(col) && !esNumeroValido(txt)) {
    console.log(`[PDF-FIX2] descartado no-numero: "${txt}" en columna ${col} fila ${filaNum}`);
    return null;
  }

  return col;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACCIÓN PDF (pdf2json)
// ═══════════════════════════════════════════════════════════════════════════════

function extraerDatosCrudos(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', resolve);
    parser.on('pdfParser_dataError', err =>
      reject(new Error(`pdf2json: ${err.parserError || JSON.stringify(err)}`))
    );
    parser.parseBuffer(buffer);
  });
}

function extraerItems(pdfData) {
  const items = [];
  pdfData.Pages.forEach((page, pi) => {
    for (const txt of (page.Texts || [])) {
      const text = txt.R.map(r => decodeURIComponent(r.T)).join('').trim();
      if (text) items.push({ page: pi + 1, x: txt.x, y: txt.y, text });
    }
  });
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE VLines
// ═══════════════════════════════════════════════════════════════════════════════

function detectarVLines(pdfData, alturaMinima = 5) {
  const xs = [];
  for (const page of pdfData.Pages) {
    for (const vl of (page.VLines || [])) {
      if ((vl.l || 0) >= alturaMinima) xs.push(vl.x);
    }
  }
  if (xs.length < 2) return [];

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

// ═══════════════════════════════════════════════════════════════════════════════
// AGRUPACIÓN EN FILAS
// ═══════════════════════════════════════════════════════════════════════════════

function agruparEnFilas(items, tolerancia = 0.4) {
  const mapa = [];
  for (const item of items) {
    const fila = mapa.find(
      f => f.page === item.page && Math.abs(f.y - item.y) <= tolerancia
    );
    if (fila) fila.items.push({ x: item.x, text: item.text });
    else      mapa.push({ page: item.page, y: item.y, items: [{ x: item.x, text: item.text }] });
  }
  mapa.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);
  mapa.forEach(f => f.items.sort((a, b) => a.x - b.x));
  return mapa;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE ENCABEZADO
// ═══════════════════════════════════════════════════════════════════════════════

function detectarEncabezado(filas) {
  for (let i = 0; i < filas.length; i++) {
    const colMap = {};
    for (const item of filas[i].items) {
      const norm = normText(item.text);
      for (const [col, aliases] of Object.entries(COL_ALIASES)) {
        if (colMap[col] !== undefined) continue;
        if (aliases.some(a => norm === a || norm.startsWith(a + ' ') || norm === a.replace(/ /g, ''))) {
          colMap[col] = item.x;
        }
      }
    }
    // Mínimo: cargos + abonos identificados
    if (colMap.cargos !== undefined && colMap.abonos !== undefined) {
      console.log(`[PDF] Encabezado en fila ${i}:`, JSON.stringify(colMap));
      return { headerIdx: i, headerPage: filas[i].page, colMap };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASIGNACIÓN DE COLUMNA — MODO VLines (fronteras exactas)
// ═══════════════════════════════════════════════════════════════════════════════

function crearZonasVLines(colMap, fronteras) {
  const zonas = {};
  for (const [col, cx] of Object.entries(colMap)) {
    let xMin = -Infinity, xMax = Infinity;
    if (cx < fronteras[0]) {
      xMax = fronteras[0];
    } else if (cx >= fronteras[fronteras.length - 1]) {
      xMin = fronteras[fronteras.length - 1];
    } else {
      for (let i = 0; i < fronteras.length - 1; i++) {
        if (cx >= fronteras[i] && cx < fronteras[i + 1]) {
          xMin = fronteras[i]; xMax = fronteras[i + 1]; break;
        }
      }
    }
    zonas[col] = { xMin, xMax };
  }
  console.log('[PDF] Zonas por VLines:', JSON.stringify(
    Object.fromEntries(Object.entries(zonas).map(([c, z]) =>
      [c, `[${isFinite(z.xMin) ? z.xMin.toFixed(2) : '-∞'}, ${isFinite(z.xMax) ? z.xMax.toFixed(2) : '+∞'})`]
    ))
  ));
  return zonas;
}

function asignarPorZona(fila, zonas, filaNum = 0) {
  const celdas = {};
  for (const item of fila.items) {
    for (const [col, { xMin, xMax }] of Object.entries(zonas)) {
      if (item.x >= xMin && item.x < xMax) {
        const colFinal = resolverColumna(col, item.text, filaNum);
        if (colFinal !== null) {
          if (['cargos', 'abonos'].includes(col) && esNumeroValido(item.text)) {
            console.log(`[PDF-ABONO] fila ${filaNum}: valor=${item.text} x=${item.x.toFixed(3)} asignado_a=${col} tipo=${col === 'abonos' ? 'ingreso' : 'egreso'}`);
          }
          celdas[colFinal] = ((celdas[colFinal] || '') + ' ' + item.text).trim();
        }
        break;
      }
    }
  }
  return celdas;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASIGNACIÓN DE COLUMNA — FALLBACK (distancia mínima al encabezado)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Cada elemento va a la columna cuyo x de encabezado está más cercano.
// Ejemplo (Scotiabank):
//   x=18.132, docto=18.597, cargos=22.169 → dist 0.465 vs 4.037 → docto ✓
//   x=23.002, cargos=22.169, abonos=25.756 → dist 0.833 vs 2.754 → cargos ✓

function asignarPorDistancia(fila, colMap, filaNum = 0) {
  const cols = Object.entries(colMap);
  const celdas = {};
  for (const item of fila.items) {
    let nearestCol = null, minDist = Infinity;
    for (const [col, cx] of cols) {
      const dist = Math.abs(item.x - cx);
      if (dist < minDist) { minDist = dist; nearestCol = col; }
    }
    if (nearestCol) {
      const colFinal = resolverColumna(nearestCol, item.text, filaNum);
      if (colFinal !== null) {
        if (['cargos', 'abonos'].includes(nearestCol) && esNumeroValido(item.text)) {
          console.log(`[PDF-ABONO] fila ${filaNum}: valor=${item.text} x=${item.x.toFixed(3)} asignado_a=${nearestCol} tipo=${nearestCol === 'abonos' ? 'ingreso' : 'egreso'}`);
        }
        celdas[colFinal] = ((celdas[colFinal] || '') + ' ' + item.text).trim();
      }
    }
  }
  return celdas;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function parsearPDF(buffer) {
  // ── Extracción ──────────────────────────────────────────────────────────────
  const pdfData = await extraerDatosCrudos(buffer);
  const fronteras = detectarVLines(pdfData);
  const items = extraerItems(pdfData);

  console.log(`[PDF] Items de texto extraídos: ${items.length}`);
  if (items.length === 0) {
    throw new Error('El PDF no contiene texto seleccionable (posiblemente escaneado).');
  }

  const filas = agruparEnFilas(items);
  console.log(`[PDF] Filas agrupadas: ${filas.length}`);

  const header = detectarEncabezado(filas);
  if (!header) {
    console.log('[PDF] No se detectó encabezado. Primeras 15 filas:');
    filas.slice(0, 15).forEach((f, i) => {
      const txt = f.items.map(it => `[x${it.x.toFixed(1)}]"${it.text}"`).join(' ');
      console.log(`  [${i}] p${f.page} y=${f.y.toFixed(2)} → ${txt}`);
    });
    return [];
  }

  // ── Método de asignación ────────────────────────────────────────────────────
  const usaVLines = fronteras.length >= 2;
  const zonas     = usaVLines ? crearZonasVLines(header.colMap, fronteras) : null;

  if (!usaVLines) {
    console.log('[PDF] Sin VLines → distancia mínima al encabezado:', JSON.stringify(header.colMap));
  }

  // ── Contadores para resumen de filas descartadas ────────────────────────────
  const skipped = { sinFecha: 0, sinMonto: 0, descInvalida: 0, encabezadoRep: 0 };

  const transacciones = [];
  let filaAnterior = null;

  for (let i = header.headerIdx + 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila.page < header.headerPage) continue;

    // ── P5: Encabezado repetido ────────────────────────────────────────────────
    if (esEncabezadoRepetido(fila)) {
      console.log(`[PDF-SKIP] fila ${i}: encabezado repetido`);
      skipped.encabezadoRep++;
      continue;
    }

    // ── Asignar columnas ────────────────────────────────────────────────────────
    const celdas = usaVLines
      ? asignarPorZona(fila, zonas, i)
      : asignarPorDistancia(fila, header.colMap, i);

    // ── P1: Filtro de fecha ─────────────────────────────────────────────────────
    const fechaStr = (celdas.fecha || '').trim();

    if (!fechaStr) {
      // Fila sin fecha → posible continuación de descripción (Itaú, multi-línea)
      if (filaAnterior && celdas.descripcion) {
        filaAnterior.descripcion_original += ' ' + celdas.descripcion.trim();
        filaAnterior.descripcion_normalizada =
          filaAnterior.descripcion_original.toLowerCase().replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    if (!esFechaValida(fechaStr)) {
      console.log(`[PDF-SKIP] fila ${i}: sin fecha válida → "${fechaStr}"`);
      skipped.sinFecha++;
      continue;
    }

    const fecha = normalizarFecha(fechaStr);
    if (!fecha) {
      console.log(`[PDF-SKIP] fila ${i}: sin fecha válida → "${fechaStr}"`);
      skipped.sinFecha++;
      continue;
    }

    // ── P3: Filtro de descripción ───────────────────────────────────────────────
    const descripcion = (celdas.descripcion || '').trim();
    if (descripcion.length < 3 || /^\d+$/.test(descripcion) ||
        SKIP_DESC_RE.test(normText(descripcion))) {
      console.log(`[PDF-SKIP] fila ${i}: descripción inválida → "${descripcion}"`);
      skipped.descInvalida++;
      continue;
    }

    // ── Número de documento (Regla 1: NUNCA es monto) ─────────────────────────
    const textoDocto = (celdas.docto || '').trim();
    const mDocto     = textoDocto.match(/[\w][\w\-]*/);
    const numero_documento = mDocto ? mDocto[0] : null;

    // ── Regla inviolable: columna → tipo ──────────────────────────────────────
    // La IA NUNCA decide esto. Solo la posición de la columna.
    const vCargo = parsearMonto(celdas.cargos);
    const vAbono = parsearMonto(celdas.abonos);

    let cargo = 0, abono = 0, monto = null, tipo = null;

    if (vCargo && vCargo > 0) {
      cargo = vCargo; monto = vCargo; tipo = 'egreso';
    } else if (vAbono && vAbono > 0) {
      abono = vAbono; monto = vAbono; tipo = 'ingreso';
    }

    // ── P2: Filtro de monto ─────────────────────────────────────────────────────
    if (!monto || monto <= 0) {
      console.log(`[PDF-SKIP] fila ${i}: sin monto válido`);
      skipped.sinMonto++;
      continue;
    }

    // ── P4: Saldo posterior ─────────────────────────────────────────────────────
    const saldo_posterior = parsearMonto(celdas.saldo) || null;

    // ── Construir transacción ───────────────────────────────────────────────────
    const tx = {
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      numero_documento,
      tipo,
      monto_original:          monto,
      saldo_posterior,
      moneda_original:         'CLP',
      fuente:                  'cartola_banco',
      cargo,
      abono,
    };

    transacciones.push(tx);
    filaAnterior = tx;
  }

  // ── Resumen de filas descartadas ──────────────────────────────────────────
  console.log(
    `[PDF] Resumen de filas descartadas — ` +
    `sin fecha: ${skipped.sinFecha} | ` +
    `sin monto: ${skipped.sinMonto} | ` +
    `desc inválida: ${skipped.descInvalida} | ` +
    `encabezado repetido: ${skipped.encabezadoRep}`
  );
  console.log(`[PDF] Transacciones extraídas: ${transacciones.length}`);

  return transacciones;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

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
