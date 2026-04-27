# SKILL: Parseo de Cartolas Bancarias Chilenas

**Versión:** 1.0  
**Alcance:** Identificar y extraer transacciones desde cartolas bancarias chilenas en formato texto (PDF extraído), Excel o CSV.  
**Output esperado:** Array JSON de transacciones estructuradas.

---

## Objetivo

Dado el contenido textual de una cartola bancaria chilena (cualquier banco), extraer cada transacción y producir un objeto JSON por movimiento con los campos:

```json
{
  "fecha_transaccion":       "YYYY-MM-DD",
  "descripcion_original":    "texto libre",
  "numero_documento":        "12345678 o null",
  "tipo":                    "ingreso | egreso",
  "monto_original":          123456.78,
  "saldo_posterior":         987654.00,
  "moneda_original":         "CLP"
}
```

---

## FASE 1 — Identificar el encabezado de la tabla

### 1.1 Qué buscar

Localiza la fila (o línea) que contenga **al menos una palabra de la columna Cargo Y al menos una de la columna Abono**. Esa es la fila de encabezado.

**Alias de la columna Cargo (egreso):**
```
cargo, cargos, débito, débitos, debito, debitos
```

**Alias de la columna Abono (ingreso):**
```
abono, abonos, crédito, créditos, credito, creditos
```

**Alias de la columna Docto.:**
```
docto, docto., n° doc, n°doc, nro. doc, nro.doc, nro, documento, n°, num, num doc
```

**Alias de la columna Saldo:**
```
saldo, saldo ($), balance, saldo final, saldo disponible
```

**Alias de la columna Descripción:**
```
descripcion, descripción, glosa, movimiento, concepto, detalle
```

### 1.2 Normalización para comparar

Antes de buscar aliases, normalizar el texto del encabezado:
- Convertir a minúsculas
- Eliminar tildes: á→a, é→e, í→i, ó→o, ú→u, ñ→n
- Ignorar signos de puntuación extra (`.`, `$`, `(`, `)`)

Ejemplo: `"Débitos ($)"` → normaliza a `"debitos"` → coincide con alias `debitos`.

### 1.3 Registrar posiciones

**Para PDF (texto plano con alineación):** registrar el índice de carácter donde comienza cada palabra de encabezado en la línea. Estas posiciones se usarán para clasificar los montos en filas de datos.

**Para Excel/CSV:** cada columna tiene un índice de columna fijo (0, 1, 2...). La posición de carácter no aplica.

---

## FASE 2 — Reglas críticas de desambiguación

Antes de procesar filas, interioriza estas reglas. Son la causa más común de errores:

### REGLA 1 — Docto. NUNCA es un monto

La columna `Docto.` (y sus variantes) contiene un **identificador interno del banco**, no un valor monetario.

```
CORRECTO:   numero_documento = "1234567"   (como texto)
INCORRECTO: monto_original   = 1234567     (como número)
```

Un número como `1234567` que aparece en la columna Docto. puede confundirse con un monto grande. **Siempre extrae el Docto. como texto y en su zona de columna, nunca como parte del monto de la transacción.**

La zona del Docto. está entre el fin de la descripción y el inicio de la columna Cargos. Cualquier número en esa zona es el documento, no el monto.

### REGLA 2 — Cargos = egreso, Abonos = ingreso (SIEMPRE positivos)

Los montos en cartolas chilenas son **siempre positivos**. El tipo se determina por la columna, no por el signo.

```
Cargos ($)    →  tipo: "egreso"   (dinero que SALE de la cuenta)
Abonos ($)    →  tipo: "ingreso"  (dinero que ENTRA a la cuenta)
```

Nunca inferir tipo por el signo del número (excepto como último recurso en fallback).

### REGLA 3 — Saldo no es el monto de la transacción

La columna Saldo contiene el saldo de la cuenta **después** del movimiento. Es `saldo_posterior`, no `monto_original`.

En una fila típica hay 2 números en la zona de montos:
- El primero (en columna Cargo o Abono) → `monto_original`
- El último (en columna Saldo, más a la derecha) → `saldo_posterior`

### REGLA 4 — Una fila = un movimiento

Cada fila con fecha corresponde a exactamente una transacción. Si la descripción está cortada y continúa en la línea siguiente sin fecha, concatenar ambas líneas como descripción.

---

## FASE 3 — Procesar cada fila de datos

Para cada línea/fila que tenga una fecha válida:

### 3.1 Extraer fecha

Formatos aceptados (en orden de prioridad):

| Patrón | Ejemplo | Resultado |
|---|---|---|
| `DD/MM/YYYY` | `03/01/2026` | `2026-01-03` |
| `DD-MM-YYYY` | `03-01-2026` | `2026-01-03` |
| `DD/MM/YY` | `03/01/26` | `2026-01-03` |
| `YYYY-MM-DD` | `2026-01-03` | `2026-01-03` (ya está en formato ISO) |

Para año de 2 dígitos: si `YY > 50` → `19YY`, si `YY ≤ 50` → `20YY`.

### 3.2 Extraer numero_documento

Buscar en la zona de caracteres comprendida entre el fin del campo descripción y el inicio de la columna Cargos.

- Tomar la primera secuencia de dígitos (y/o alfanuméricos si incluye prefijo como `DOC-`)
- Guardar como texto: `"1234567"`, `"DOC-12345"`, `"00012345"`
- Si no hay nada en esa zona → `null`
- **No intentar parsear este valor como número**

### 3.3 Extraer monto_original y tipo

**Si se detectaron columnas Cargo y Abono (caso principal):**

Calcular el punto medio entre la posición del encabezado Cargo y el encabezado Abono:
```
midpoint = (posicion_cargo + posicion_abono) / 2
```

Para cada número en la fila que esté dentro de la zona de montos (a partir de la columna Cargo):
- Si `posicion_inicio_numero < midpoint` → es un Cargo → `tipo: "egreso"`
- Si `posicion_inicio_numero ≥ midpoint` → es un Abono → `tipo: "ingreso"`

El primer número clasificado es `monto_original`. El último número de la fila (el más a la derecha) es `saldo_posterior`.

**Si NO se detectaron columnas (fallback):**

1. Si el número tiene signo negativo → `tipo: "egreso"`, ignorar signo para el monto
2. Si hay múltiples números y el penúltimo es el monto: buscar si crece o decrece vs saldo para inferir tipo
3. Sin información suficiente → `tipo: "egreso"` (default conservador)

### 3.4 Parsear montos en formato chileno

Los montos en CLP usan punto como separador de miles y coma como separador decimal.

**Algoritmo de parseo:**

1. Eliminar `$` y espacios
2. Si contiene AMBOS `.` y `,`:
   - Si la última coma va DESPUÉS del último punto → formato chileno: `1.234,56` → `1234.56`
   - Si el último punto va DESPUÉS de la última coma → formato anglosajón: `1,234.56` → `1234.56`
3. Si solo tiene `,` (sin punto):
   - Si hay exactamente 1 coma y máximo 2 dígitos después → decimal: `1234,56` → `1234.56`
   - Si hay más → separador de miles: `1,234,567` → `1234567`
4. Si solo tiene `.` (sin coma):
   - Si hay exactamente 1 punto y exactamente 3 dígitos después → miles: `1.234` → `1234`
   - Caso contrario → decimal: `1.5` → `1.5`
5. Sin separadores: `1234567` → `1234567`

**Ejemplos de parseo:**

| Texto en cartola | Resultado numérico |
|---|---|
| `150.000` | `150000` |
| `1.234.567` | `1234567` |
| `150.000,00` | `150000.00` |
| `1.234.567,89` | `1234567.89` |
| `150000` | `150000` |
| `1234` | `1234` |
| `1.500` | `1500` (3 decimales → miles) |
| `1.50` | `1.50` (2 decimales → decimal) |

### 3.5 Extraer descripcion_original

Tomar el texto de la fila que no sea fecha, numero_documento ni montos.

- Eliminar la fecha
- Eliminar todos los números que sean montos (en zona de cargos/abonos/saldo)
- NO eliminar el numero_documento si ya fue extraído por separado
- Limpiar espacios múltiples
- Si el resultado tiene menos de 5 caracteres y la fila siguiente no tiene fecha → concatenar siguiente línea

### 3.6 Extraer saldo_posterior

El monto más a la derecha en la fila (último número en la zona de montos).
Si solo hay un número en la zona de montos → `null` (podría ser solo el saldo o solo el monto, ambiguo).

---

## FASE 4 — Validación por fila

Antes de incluir una transacción en el resultado, verificar:

| Campo | Condición para aceptar |
|---|---|
| `fecha_transaccion` | Fecha válida en formato YYYY-MM-DD |
| `descripcion_original` | Al menos 3 caracteres |
| `monto_original` | Número mayor a 0 |
| `tipo` | Exactamente `"ingreso"` o `"egreso"` |

Si alguna condición falla → descartar la fila silenciosamente.

---

## FASE 5 — Ejemplos completos por banco

### BancoEstado

**Entrada (texto del PDF o fila de Excel):**
```
Fecha       Descripción/Movimiento                    Docto.     Cargos ($)    Abonos ($)    Saldo ($)
03/01/2026  PAGO PROVEEDOR XYZ                        1234567    150.000                     850.000
05/01/2026  ABONO TRANSFERENCIA ELECTRONICA                                    200.000     1.050.000
10/01/2026  COMISION MANTENC CTA CTE                 9900001     3.490                      846.510
```

**Salida esperada:**
```json
[
  {
    "fecha_transaccion":    "2026-01-03",
    "descripcion_original": "PAGO PROVEEDOR XYZ",
    "numero_documento":     "1234567",
    "tipo":                 "egreso",
    "monto_original":       150000,
    "saldo_posterior":      850000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-05",
    "descripcion_original": "ABONO TRANSFERENCIA ELECTRONICA",
    "numero_documento":     null,
    "tipo":                 "ingreso",
    "monto_original":       200000,
    "saldo_posterior":      1050000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-10",
    "descripcion_original": "COMISION MANTENC CTA CTE",
    "numero_documento":     "9900001",
    "tipo":                 "egreso",
    "monto_original":       3490,
    "saldo_posterior":      846510,
    "moneda_original":      "CLP"
  }
]
```

**Trampas de este banco:**
- `1234567` es Docto., NO el monto. El monto es `150.000` = 150000.
- El Docto. `9900001` también parece un monto grande. Siempre mirar la columna, no el valor.
- Fila del 05/01: la columna Docto. está vacía (la celda está en blanco) → `numero_documento: null`.

---

### Santander

**Entrada:**
```
Fecha        Descripción                          N° Doc      Cargo         Abono         Saldo
03-01-2026   PAGO A PROVEEDOR                     00012345    150.000,00                  850.000,00
05-01-2026   TRANSFERENCIA RECIBIDA               00098765                  200.000,00  1.050.000,00
08-01-2026   PAGO IMPUESTO SII                    00045678    45.890,00                   804.110,00
```

**Salida esperada:**
```json
[
  {
    "fecha_transaccion":    "2026-01-03",
    "descripcion_original": "PAGO A PROVEEDOR",
    "numero_documento":     "00012345",
    "tipo":                 "egreso",
    "monto_original":       150000.00,
    "saldo_posterior":      850000.00,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-05",
    "descripcion_original": "TRANSFERENCIA RECIBIDA",
    "numero_documento":     "00098765",
    "tipo":                 "ingreso",
    "monto_original":       200000.00,
    "saldo_posterior":      1050000.00,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-08",
    "descripcion_original": "PAGO IMPUESTO SII",
    "numero_documento":     "00045678",
    "tipo":                 "egreso",
    "monto_original":       45890.00,
    "saldo_posterior":      804110.00,
    "moneda_original":      "CLP"
  }
]
```

**Trampas de este banco:**
- Fecha con guion: `03-01-2026` → mismo resultado que `/`.
- Montos con `,00`: `150.000,00` → parsear como chileno → `150000.00`.
- Docto. con ceros a la izquierda (`00012345`) → guardar como texto, no número (si fuera número perdería los ceros).
- El separador de fecha es `-` en vez de `/` — no confundir con número negativo.

---

### BCI

**Entrada:**
```
Fecha      Descripción                        Nro. Doc    Débitos       Créditos      Saldo
03/01/26   CARGO PROVEEDOR ABC                56789       150.000                     850.000
05/01/26   ABONO TRF RECIBIDA                 11223                     200.000     1.050.000
07/01/26   REMUNERACIONES ENERO               78901       3.250.000                (2.400.000)
```

**Salida esperada:**
```json
[
  {
    "fecha_transaccion":    "2026-01-03",
    "descripcion_original": "CARGO PROVEEDOR ABC",
    "numero_documento":     "56789",
    "tipo":                 "egreso",
    "monto_original":       150000,
    "saldo_posterior":      850000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-05",
    "descripcion_original": "ABONO TRF RECIBIDA",
    "numero_documento":     "11223",
    "tipo":                 "ingreso",
    "monto_original":       200000,
    "saldo_posterior":      1050000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-07",
    "descripcion_original": "REMUNERACIONES ENERO",
    "numero_documento":     "78901",
    "tipo":                 "egreso",
    "monto_original":       3250000,
    "saldo_posterior":      2400000,
    "moneda_original":      "CLP"
  }
]
```

**Trampas de este banco:**
- Año de 2 dígitos: `03/01/26` → `26 ≤ 50` → `2026-01-03`.
- Columnas `Débitos` / `Créditos` en vez de `Cargos` / `Abonos` → normalizar como cargo/abono.
- Saldo negativo entre paréntesis: `(2.400.000)` → algunos bancos usan esta notación contable → extraer `2400000` como `saldo_posterior`. No afecta el `monto_original` ni el `tipo`.
- `3.250.000`: tres puntos → cada tramo tiene 3 dígitos → todos son separadores de miles → `3250000`.

---

### Scotiabank

**Entrada:**
```
Fecha         Glosa                                    Documento    Cargo         Abono         Saldo
03/01/2026    PAGO FACTURA PROVEEDOR                   DOC-12345    150.000                     850.000
05/01/2026    DEPOSITO TRANSFERENCIA                   DOC-98765                  200.000     1.050.000
12/01/2026    ARRIENDO OFICINA ENERO 2026              DOC-11100    1.200.000                 (350.000)
```

**Salida esperada:**
```json
[
  {
    "fecha_transaccion":    "2026-01-03",
    "descripcion_original": "PAGO FACTURA PROVEEDOR",
    "numero_documento":     "DOC-12345",
    "tipo":                 "egreso",
    "monto_original":       150000,
    "saldo_posterior":      850000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-05",
    "descripcion_original": "DEPOSITO TRANSFERENCIA",
    "numero_documento":     "DOC-98765",
    "tipo":                 "ingreso",
    "monto_original":       200000,
    "saldo_posterior":      1050000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-12",
    "descripcion_original": "ARRIENDO OFICINA ENERO 2026",
    "numero_documento":     "DOC-11100",
    "tipo":                 "egreso",
    "monto_original":       1200000,
    "saldo_posterior":      350000,
    "moneda_original":      "CLP"
  }
]
```

**Trampas de este banco:**
- Columna descripción se llama `Glosa`, no `Descripción`.
- Número de documento alfanumérico: `DOC-12345` → guardar completo como texto.
- La glosa `ARRIENDO OFICINA ENERO 2026` contiene `2026` — NO es un monto. La descripción se construye eliminando solo los números en la zona de montos (Cargo/Abono/Saldo), no los números dentro del texto.
- Saldo `(350.000)` → negativo contable → `saldo_posterior: 350000` (extraer valor absoluto).

---

### Itaú

**Entrada:**
```
Fecha        Concepto                              N°          Débito        Crédito       Saldo
03/01/2026   PAGO PROVEEDOR                        000012345   150.000                     850.000
05/01/2026   TRANSFERENCIA RECIBIDA                000098765                 200.000     1.050.000
09/01/2026   HONORARIOS PROF. SERVICIOS            000034567   850.000                     200.000
             CONTABLES Y ASESORÍA FISCAL
```

**Salida esperada:**
```json
[
  {
    "fecha_transaccion":    "2026-01-03",
    "descripcion_original": "PAGO PROVEEDOR",
    "numero_documento":     "000012345",
    "tipo":                 "egreso",
    "monto_original":       150000,
    "saldo_posterior":      850000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-05",
    "descripcion_original": "TRANSFERENCIA RECIBIDA",
    "numero_documento":     "000098765",
    "tipo":                 "ingreso",
    "monto_original":       200000,
    "saldo_posterior":      1050000,
    "moneda_original":      "CLP"
  },
  {
    "fecha_transaccion":    "2026-01-09",
    "descripcion_original": "HONORARIOS PROF. SERVICIOS CONTABLES Y ASESORÍA FISCAL",
    "numero_documento":     "000034567",
    "tipo":                 "egreso",
    "monto_original":       850000,
    "saldo_posterior":      200000,
    "moneda_original":      "CLP"
  }
]
```

**Trampas de este banco:**
- Columnas `Débito` / `Crédito` (singular) en vez de plural.
- Columna doc es `N°` (muy corto) → no confundir con encabezado de número de línea.
- Descripción en dos líneas: la fila del 09/01 tiene la descripción cortada; la línea siguiente (`CONTABLES Y ASESORÍA FISCAL`) no tiene fecha → concatenar → descripción completa.
- Docto. con ceros a la izquierda (`000012345`) → texto, no número.

---

## FASE 6 — Casos borde y situaciones especiales

### Línea de encabezado no encontrada

Si no se detecta una fila con alias de Cargo Y Abono:
- Intentar detección por alias sueltos: si solo se encuentra `saldo` → asumir formato de monto único con signo
- Si no se encuentra nada → reportar error: `"No se detectó tabla de transacciones en el documento"`

### Monto en zona ambigua (cerca del midpoint)

Si un monto cae dentro de ±3 caracteres del midpoint entre Cargo y Abono:
- Revisar si hay otro número en la misma fila claramente a la izquierda (cargo) o derecha (abono)
- Si aún es ambiguo → asignar `tipo: "egreso"` (default conservador) y marcar baja confianza

### Fila de totales o subtotales

Algunas cartolas incluyen filas de resumen (e.g., `"TOTAL CARGOS    5.670.000"`). Identificarlas porque:
- No tienen fecha válida → serán descartadas automáticamente por la validación de fecha
- Pueden tener fechas si son cierres de período → verificar que la descripción no sea `"SALDO ANTERIOR"`, `"TOTAL"`, `"SUBTOTAL"` → descartar

### Montos entre paréntesis (notación contable)

`(150.000)` equivale a `-150.000` en notación contable. En cartolas chilenas indica saldo deudor (cuenta en rojo). Para `saldo_posterior` extraer el valor absoluto. Para `monto_original` esta notación no debería aparecer (los montos siempre son positivos en su columna).

### Descripción con números internos

Descripciones como `"CUOTA 3/12 PRESTAMO"`, `"FACTURA 2026-001234"`, `"IVA 19%"` contienen números que NO son montos. Estos números están en la zona de la descripción (antes de la columna Cargos) y deben quedar en `descripcion_original`.

Solo eliminar números que estén en la zona de montos (a partir de la columna Cargos en adelante).

### PDF con columnas desalineadas

Algunos PDFs generan texto con espaciado variable. Si la detección por posición falla:
- Verificar si hay exactamente 1 número no-saldo en la fila → ese es el monto
- Usar palabras clave en la descripción como heurística de tipo:
  - Palabras de egreso: `pago`, `cargo`, `debito`, `retiro`, `cuota`, `comision`, `impuesto`
  - Palabras de ingreso: `abono`, `deposito`, `transferencia recibida`, `credito`, `remuneracion`

---

## Resumen de reglas absolutas

| # | Regla |
|---|---|
| 1 | Docto./N° Doc **NUNCA** es un monto. Guardarlo como texto. |
| 2 | Los montos en Cargos son siempre **positivos** → `tipo: "egreso"` |
| 3 | Los montos en Abonos son siempre **positivos** → `tipo: "ingreso"` |
| 4 | El número más a la derecha de la fila es el **saldo**, no el monto |
| 5 | `1.234` con 3 decimales = **1234** (miles), no 1.234 decimal |
| 6 | `1.234,56` = **1234.56** (formato chileno con coma decimal) |
| 7 | Año de 2 dígitos ≤ 50 → **20XX**, > 50 → **19XX** |
| 8 | Saldo entre paréntesis `(1.234)` = valor absoluto **1234** |
| 9 | Números dentro de la descripción (ej: `CUOTA 3/12`) **no son montos** |
| 10 | Una línea sin fecha que sigue a una con fecha = **continuación de descripción** |
