# Estructura de Cartolas Bancarias Chilenas

Referencia de los formatos de cartola bancaria chilena soportados por UTZ Finance.
Aplica tanto a archivos Excel/CSV como a PDF.

---

## Estructura estándar

La mayoría de los bancos chilenos usan una tabla con estas columnas, en este orden:

| Columna | Campo UTZ | Tipo | Notas |
|---|---|---|---|
| Fecha | `fecha_transaccion` | DATE (YYYY-MM-DD) | Varios formatos según banco |
| Descripción / Glosa / Movimiento | `descripcion_original` | TEXT | El nombre varía por banco |
| Docto. / N° Doc / Nro. | `numero_documento` | TEXT | Identificador interno. **Nunca es un monto** |
| Cargos / Débito | `monto_original` + `tipo: 'egreso'` | NUMERIC | Positivo siempre |
| Abonos / Crédito | `monto_original` + `tipo: 'ingreso'` | NUMERIC | Positivo siempre |
| Saldo | `saldo_posterior` | NUMERIC | Saldo resultante después del movimiento |

---

## Variaciones por banco

### BancoEstado

```
Fecha       Descripción/Movimiento                    Docto.     Cargos ($)    Abonos ($)    Saldo ($)
03/01/2026  PAGO PROVEEDOR XYZ                        1234567    150.000                     850.000
05/01/2026  ABONO TRANSFERENCIA ELECTRONICA                                    200.000     1.050.000
```

- **Formato fecha:** DD/MM/YYYY
- **Columna doc:** `Docto.`
- **Separador miles:** `.` (punto)
- **Decimales:** `,` (coma) — pero raramente aparecen en CLP
- **PDF:** columnas bien alineadas, detección por posición funciona bien

---

### Santander

```
Fecha        Descripción                          N° Doc      Cargo         Abono         Saldo
03-01-2026   PAGO A PROVEEDOR                     00012345    150.000,00                  850.000,00
05-01-2026   TRANSFERENCIA RECIBIDA               00098765                  200.000,00  1.050.000,00
```

- **Formato fecha:** DD-MM-YYYY
- **Columna doc:** `N° Doc`
- **Separador miles:** `.` (punto), decimal `,` (coma)
- **PDF:** montos con decimales `,00`; columnas alineadas a la derecha

---

### BCI

```
Fecha      Descripción                        Nro. Doc    Débitos       Créditos      Saldo
03/01/26   CARGO PROVEEDOR ABC                56789       150.000                     850.000
05/01/26   ABONO TRF RECIBIDA                 11223                     200.000     1.050.000
```

- **Formato fecha:** DD/MM/YY (año 2 dígitos)
- **Columna doc:** `Nro. Doc`
- **Columnas monto:** `Débitos` / `Créditos` (en vez de Cargos/Abonos)
- **Nota:** el procesador detecta `debito`/`credito` además de `cargo`/`abono`

---

### Scotiabank

```
Fecha         Glosa                                    Documento   Cargo         Abono         Saldo
03/01/2026    PAGO FACTURA PROVEEDOR                   DOC-12345   150.000                     850.000
05/01/2026    DEPOSITO TRANSFERENCIA                   DOC-98765                 200.000     1.050.000
```

- **Formato fecha:** DD/MM/YYYY
- **Columna desc:** `Glosa`
- **Columna doc:** `Documento` (texto completo, puede incluir prefijo como `DOC-`)
- **Columnas monto:** `Cargo` / `Abono` (singular)
- **Nota:** el número de documento puede incluir prefijos no numéricos

---

### Itaú

```
Fecha        Concepto                              N°          Débito        Crédito       Saldo
03/01/2026   PAGO PROVEEDOR                        000012345   150.000                     850.000
05/01/2026   TRANSFERENCIA RECIBIDA                000098765                 200.000     1.050.000
```

- **Formato fecha:** DD/MM/YYYY
- **Columna desc:** `Concepto`
- **Columna doc:** `N°`
- **Columnas monto:** `Débito` / `Crédito`
- **PDF:** espaciado variable; puede requerir combinar líneas adyacentes para descripción completa

---

## Consideraciones generales

### Columna Docto. / N° Doc

- **Es un identificador interno del banco**, no un monto
- Puede ser puramente numérico (`12345`) o alfanumérico (`DOC-12345`, `TRF-00001`)
- Se almacena en `numero_documento` como texto (TEXT)
- El procesador lo extrae buscando en la zona entre el encabezado `Docto.` y el encabezado `Cargos`
- **Nunca debe confundirse con el monto de la transacción**

### Formatos de monto en CLP

| Formato | Ejemplo | Observación |
|---|---|---|
| Punto como separador de miles | `1.234.567` | Más común en Chile |
| Sin separador | `1234567` | Algunos PDFs pierden el formato |
| Con decimales en coma | `1.234,56` | Aparece en algunos bancos |
| Negativo con signo | `-150.000` | Raro en cartolas (usan columnas separadas) |

### Formatos de fecha

| Formato | Ejemplo | Banco |
|---|---|---|
| DD/MM/YYYY | `03/01/2026` | BancoEstado, Santander, Scotiabank, Itaú |
| DD-MM-YYYY | `03-01-2026` | Santander (alternativo) |
| DD/MM/YY | `03/01/26` | BCI |
| YYYY-MM-DD | `2026-01-03` | Exportaciones propias / APIs |

### PDFs vs Excel

| Aspecto | Excel/CSV | PDF |
|---|---|---|
| Detección de columnas | Por nombre de encabezado en fila | Por posición de carácter en el texto |
| Número de documento | Celda independiente | Zona entre columnas según posición |
| Saldo | Celda independiente | Último número de la fila |
| Confiabilidad | Alta | Media (depende del alineado del PDF) |

---

## Archivos del procesador

| Archivo | Formatos |
|---|---|
| `src/services/documentProcessor/excelProcessor.js` | `.xlsx`, `.xls`, `.csv` |
| `src/services/documentProcessor/pdfProcessor.js` | `.pdf` (solo con texto seleccionable) |
| `src/services/documentProcessor/aiCategorizer.js` | Categorización IA sobre cualquier formato |
