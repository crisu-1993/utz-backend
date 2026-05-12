// Constantes compartidas del proyecto UTZ Finance

// Secciones del EERR que corresponden a INGRESOS.
// Si una seccion_eerr no está aquí, es egreso.
const SECCIONES_INGRESO = new Set([
  'ingreso_principal',
  'ingreso_secundario',
]);

module.exports = {
  SECCIONES_INGRESO,
};
