const pdfParse = require('pdf-parse');

// ─── Patrones de fecha para cartolas bancarias chilenas ──────────────────────
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,   // DD/MM/YYYY o DD-MM-YYYY
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,   // YYYY-MM-DD
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,   // DD/MM/YY
];

function normalizarFecha(match, fmt) {
  if (fmt === 0) return `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  if (fmt === 1) return `${match[1]}-${match[2]}-${match[3]}`;
  if (fmt === 2) {
    const year = parseInt(match[3]) > 50 ? `19${match[3]}` : `20${match[3]}`;
    return `${year}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  return null;
}

function extraerFecha(texto) {
  for (let i = 0; i < FECHA_RE.length; i++) {
    const m = texto.match(FECHA_RE[i]);
    if (m) return normalizarFecha(m, i);
  }
  return null;
}

// Limpia un monto y retorna valor numérico (positivo = sin signo, negativo si había '-')
function parseMonto(s) {
  const limpio  = s.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs     = limpio.replace('-', '');

  const contienePoint = abs.includes('.');
  const contieneComa  = abs.includes(',');

  let num;
  if (contienePoint && contieneComa) {
    const lastPoint = abs.lastIndexOf('.');
    const lastComa  = abs.lastIndexOf(',');
    num = lastComa > lastPoint
      ? parseFloat(abs.replace(/\./g, '').replace(',', '.'))   // 1.234,56 → chileno
      : parseFloat(abs.replace(/,/g, ''));                      // 1,234.56 → anglosajón
  } else if (contieneComa && !contienePoint) {
    const partes = abs.split(',');
    num = (partes.length === 2 && partes[1].length <= 2)
      ? parseFloat(abs.replace(',', '.'))
      : parseFloat(abs.replace(/,/g, ''));
  } else {
    const partes = abs.split('.');
    num = (partes.length === 2 && partes[1].length === 3)
      ? parseFloat(abs.replace(/\./g, ''))   // 1.234 → miles
      : parseFloat(abs);
  }

  if (isNaN(num)) return null;
  return negativo ? -Math.abs(num) : Math.abs(num);
}

// Normaliza a minúsculas sin tildes
function normText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Aliases de columnas ─────────────────────────────────────────────────────
const COL_CARGO = ['cargo', 'cargos', 'debito', 'debitos'];
const COL_ABONO = ['abono', 'abonos', 'credito', 'creditos'];
const COL_SALDO = ['saldo'];
// Docto puede aparecer como "Docto.", "N° Doc", "Nro. Doc", "Documento", "Nro.", "N°", "Num"
const COL_DOCTO = ['docto', 'n° doc', 'nro. doc', 'documento', 'nro', 'n°', 'num doc'];

function buscarAlias(normLine, aliases) {
  for (const alias of aliases) {
    const idx = normLine.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

// ─── Detectar encabezado de tabla en el texto del PDF ────────────────────────
function detectarEncabezado(lineas) {
  for (let i = 0; i < lineas.length; i++) {
    const norm  = normText(lineas[i]);
    const cargo = buscarAlias(norm, COL_CARGO);
    const abono = buscarAlias(norm, COL_ABONO);
    if (cargo !== -1 && abono !== -1) {
      return {
        headerIdx: i,
        cargo,
        abono,
        saldo: buscarAlias(norm, COL_SALDO),
        docto: buscarAlias(norm, COL_DOCTO),
      };
    }
  }
  return { headerIdx: -1, cargo: -1, abono: -1, saldo: -1, docto: -1 };
}

// ─── Parseo línea por línea ───────────────────────────────────────────────────
function parsearLineas(texto) {
  const lineas = texto.split('\n');
  const transacciones = [];

  // Paso 1: posiciones de columnas en el encabezado
  const enc = detectarEncabezado(lineas);
  const midpoint = (enc.cargo !== -1 && enc.abono !== -1)
    ? (enc.cargo + enc.abono) / 2
    : -1;

  // Paso 2: iterar líneas de datos
  for (let i = 0; i < lineas.length; i++) {
    if (i === enc.headerIdx) continue;

    const lineaRaw  = lineas[i];          // sin trim → preserva posiciones de chars
    const lineaTrim = lineaRaw.trim();
    if (!lineaTrim) continue;

    const fecha = extraerFecha(lineaTrim);
    if (!fecha) continue;

    // ── Numero de documento (identificador, NUNCA monto) ─────────────────────
    // Se busca en la zona entre la columna Docto y la columna Cargo
    let numeroDocumento = null;
    if (enc.docto !== -1 && enc.cargo !== -1) {
      const desde = Math.max(0, enc.docto - 2);
      const hasta  = enc.cargo - 1;
      const zona   = lineaRaw.slice(desde, hasta);
      const mDocto = zona.match(/\d+/);
      if (mDocto) numeroDocumento = mDocto[0];
    }

    // ── Montos con posición (filtrar zona pre-cargo para descartar fecha/desc) ─
    const MONTO_POS_RE = /[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g;
    const montosConPos = [];
    let match;
    while ((match = MONTO_POS_RE.exec(lineaRaw)) !== null) {
      const v = parseMonto(match[0]);
      if (v === null || v === 0) continue;
      // Descartar números que aparecen antes de la columna Cargo (fecha, Docto, desc)
      if (enc.cargo !== -1 && match.index < enc.cargo - 5) continue;
      montosConPos.push({ val: v, pos: match.index });
    }

    if (montosConPos.length === 0) continue;

    // ── Saldo posterior: el monto más a la derecha ───────────────────────────
    const saldoPosterior = montosConPos.length > 1
      ? montosConPos[montosConPos.length - 1].val
      : null;

    // ── Descripción ──────────────────────────────────────────────────────────
    let descripcion = lineaTrim
      .replace(FECHA_RE[0], '').replace(FECHA_RE[1], '').replace(FECHA_RE[2], '')
      .replace(/[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (descripcion.length < 5 && i + 1 < lineas.length) {
      const next = lineas[i + 1].trim();
      if (next && !extraerFecha(next)) {
        descripcion = (descripcion + ' ' + next).trim();
        i++;
      }
    }

    if (descripcion.length < 3) continue;

    // ── Monto y tipo ─────────────────────────────────────────────────────────
    // Candidatos: todos menos el saldo (último)
    const candidatos = montosConPos.length > 1
      ? montosConPos.slice(0, -1)
      : montosConPos;

    let monto = null;
    let tipo  = null;

    if (midpoint !== -1 && candidatos.length > 0) {
      // Detección por columna: posición relativa al midpoint Cargo/Abono
      const txn = candidatos[candidatos.length - 1];
      monto = Math.abs(txn.val);
      tipo  = txn.pos < midpoint ? 'egreso' : 'ingreso';

    } else {
      // Fallback: signo del valor
      for (let j = candidatos.length - 1; j >= 0; j--) {
        const v = candidatos[j].val;
        if (v !== 0) {
          monto = Math.abs(v);
          tipo  = v < 0 ? 'egreso' : 'ingreso';
          break;
        }
      }
      // Último recurso: único monto disponible, default egreso
      if (!tipo && montosConPos.length === 1) {
        monto = Math.abs(montosConPos[0].val);
        tipo  = 'egreso';
      }
    }

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
  let data;
  try {
    data = await pdfParse(buffer);
  } catch (err) {
    throw new Error(`No se pudo leer el PDF: ${err.message}`);
  }

  const texto = data.text;
  if (!texto || texto.trim().length < 50) {
    throw new Error('El PDF no contiene texto extraíble (puede ser una imagen escaneada).');
  }

  const transacciones = parsearLineas(texto);

  if (transacciones.length === 0) {
    throw new Error('No se encontraron transacciones en el PDF. Verifique que sea una cartola bancaria con texto seleccionable.');
  }

  return transacciones;
}

module.exports = { procesarPDF };
