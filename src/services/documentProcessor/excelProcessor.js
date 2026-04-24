const XLSX = require('xlsx');

// ─── Mapeo de nombres de columnas para bancos chilenos ──────────────────────
const COL = {
  fecha:       ['fecha', 'date', 'fec', 'fecha transaccion', 'fecha de transaccion',
                'fecha mov', 'fecha movimiento', 'fecha operacion'],
  descripcion: ['descripcion', 'description', 'detalle', 'glosa', 'concepto',
                'movimiento', 'descripcion/movimiento', 'descripcion del movimiento',
                'descripcion movimiento', 'texto'],
  monto:       ['monto', 'amount', 'importe', 'valor'],
  cargo:       ['cargo', 'debito', 'débito', 'egreso', 'retiro', 'cargo(-)',
                'cargos', 'db', 'debe'],
  abono:       ['abono', 'credito', 'crédito', 'ingreso', 'deposito', 'depósito',
                'abono(+)', 'abonos', 'cr', 'haber'],
  saldo:       ['saldo', 'balance', 'saldo final', 'saldo disponible'],
};

// Normaliza texto para comparación de encabezados
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quita tildes
    .replace(/[^a-z0-9\s\/\(\)\-]/g, '')
    .trim();
}

// Encuentra la primera columna cuyo encabezado coincida con algún alias
function findCol(headers, aliases) {
  const normed = headers.map(norm);
  for (const alias of aliases) {
    const idx = normed.findIndex(h => h === alias || h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Limpia un monto: "$1.234.567,89" → 1234567.89
function parseMonto(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/[$\s]/g, '');
  // Formato chileno: punto como separador de miles, coma como decimal
  const cleaned = s.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.abs(num);
}

// Parsea fecha desde distintos formatos
function parseFecha(val) {
  if (!val) return null;

  // Número de serie de Excel
  if (typeof val === 'number') {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) {
      return new Date(date.y, date.m - 1, date.d).toISOString().split('T')[0];
    }
  }

  const s = String(val).trim();

  // DD/MM/YYYY o DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;

  // YYYY-MM-DD (ISO)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  // DD/MM/YY
  const m3 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m3) {
    const year = parseInt(m3[3]) > 50 ? `19${m3[3]}` : `20${m3[3]}`;
    return `${year}-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`;
  }

  return null;
}

// Detecta la fila de encabezados (puede no ser la primera)
function detectHeaderRow(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const colWords = Object.values(COL).flat();

  for (let r = range.s.r; r <= Math.min(range.s.r + 20, range.e.r); r++) {
    const rowValues = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      rowValues.push(cell ? String(cell.v ?? '') : '');
    }
    const normedRow = rowValues.map(norm);
    const matches = colWords.filter(w => normedRow.some(h => h.includes(w)));
    if (matches.length >= 2) return r;
  }
  return 0; // fallback: primera fila
}

// ─── Exportación principal ───────────────────────────────────────────────────
function procesarExcel(buffer, filename = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet || !sheet['!ref']) {
    throw new Error('El archivo no contiene datos legibles.');
  }

  // Detectar fila de encabezados
  const headerRowIdx = detectHeaderRow(sheet);
  const range = XLSX.utils.decode_range(sheet['!ref']);

  // Leer encabezados
  const headers = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRowIdx, c })];
    headers.push(cell ? String(cell.v ?? '') : '');
  }

  // Mapear columnas
  const colFecha  = findCol(headers, COL.fecha);
  const colDesc   = findCol(headers, COL.descripcion);
  const colMonto  = findCol(headers, COL.monto);
  const colCargo  = findCol(headers, COL.cargo);
  const colAbono  = findCol(headers, COL.abono);

  if (colFecha === -1 || colDesc === -1) {
    throw new Error(
      `No se encontraron columnas de fecha o descripción. Encabezados detectados: ${headers.join(', ')}`
    );
  }

  const tieneMontoUnico = colMonto !== -1;
  const tieneCargoAbono = colCargo !== -1 || colAbono !== -1;

  if (!tieneMontoUnico && !tieneCargoAbono) {
    throw new Error('No se encontraron columnas de monto. Revise el formato del archivo.');
  }

  // Procesar filas de datos
  const transacciones = [];

  for (let r = headerRowIdx + 1; r <= range.e.r; r++) {
    const getCell = (colIdx) => {
      if (colIdx === -1) return null;
      const cell = sheet[XLSX.utils.encode_cell({ r, c: colIdx })];
      return cell ? cell.v : null;
    };

    const rawFecha = getCell(colFecha);
    const rawDesc  = getCell(colDesc);
    const fecha    = parseFecha(rawFecha);
    const desc     = String(rawDesc ?? '').trim();

    // Saltar filas vacías o sin fecha/descripción significativa
    if (!fecha && !desc) continue;
    if (!fecha) continue;
    if (desc.length < 2) continue;

    let monto = null;
    let tipo  = null;

    if (tieneMontoUnico) {
      // Columna única de monto — detectar tipo por signo o por columna separada de cargo/abono
      const rawMonto = getCell(colMonto);
      const rawNum   = typeof rawMonto === 'number' ? rawMonto : parseFloat(
        String(rawMonto ?? '').replace(/\./g, '').replace(',', '.')
      );

      if (!isNaN(rawNum) && rawNum !== 0) {
        monto = Math.abs(rawNum);
        tipo  = rawNum < 0 ? 'egreso' : 'ingreso';
      }

      // Si hay columna de cargo además, usar para definir tipo
      if (colCargo !== -1) {
        const rawCargo = getCell(colCargo);
        const cargo    = parseMonto(rawCargo);
        if (cargo && cargo > 0) tipo = 'egreso';
      }
      if (colAbono !== -1) {
        const rawAbono = getCell(colAbono);
        const abono    = parseMonto(rawAbono);
        if (abono && abono > 0) tipo = 'ingreso';
      }

    } else {
      // Columnas separadas de cargo y abono
      const cargo = colCargo !== -1 ? parseMonto(getCell(colCargo)) : null;
      const abono = colAbono !== -1 ? parseMonto(getCell(colAbono)) : null;

      if (cargo && cargo > 0) {
        monto = cargo;
        tipo  = 'egreso';
      } else if (abono && abono > 0) {
        monto = abono;
        tipo  = 'ingreso';
      }
    }

    if (!monto || !tipo) continue;

    transacciones.push({
      fecha_transaccion:       fecha,
      descripcion_original:    desc,
      descripcion_normalizada: desc.toLowerCase().replace(/\s+/g, ' ').trim(),
      tipo,
      monto_original:          monto,
      moneda_original:         'CLP',
      fuente:                  'cartola_banco',
    });
  }

  if (transacciones.length === 0) {
    throw new Error('No se encontraron transacciones válidas en el archivo.');
  }

  return transacciones;
}

module.exports = { procesarExcel };
