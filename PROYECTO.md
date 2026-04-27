# UTZ Finance — Backend

## Qué es UTZ Finance

Plataforma financiera para PYMEs de América Latina. Permite a empresas subir documentos financieros (cartolas bancarias en Excel, CSV o PDF), procesarlos automáticamente y obtener un Estado de Resultados categorizado con IA.

- **Frontend:** Lovable (proyecto separado, ya existente)
- **Backend:** Este repositorio — Node.js + Express
- **Base de datos:** Supabase (PostgreSQL)
- **IA:** Claude (Anthropic) para categorización de transacciones

---

## Qué está construido hasta hoy (2026-04-24)

### Infraestructura
- Servidor Express en puerto 3001 con CORS habilitado
- Conexión a Supabase con `service_role` (acceso total)
- Variables de entorno via `.env`

### Base de datos (Supabase)
Dos tablas creadas con `migrations/001_create_tables.sql`:

| Tabla | Propósito |
|---|---|
| `transacciones_historicas` | Transacciones procesadas con categoría IA, monto, tipo, empresa |
| `importaciones_historicas` | Control de cada archivo subido: estado, tiempos, totales |

### Procesamiento de documentos (`src/services/documentProcessor/`)

| Archivo | Qué hace |
|---|---|
| `excelProcessor.js` | Parsea Excel/CSV de bancos chilenos. Detecta encabezados automáticamente (soporte para múltiples formatos: cargo/abono separados, monto único con signo, fechas en varios formatos) |
| `pdfProcessor.js` | Extrae texto de PDF y lo convierte a transacciones |
| `aiCategorizer.js` | Envía transacciones a Claude en lotes de 25. Clasifica en 11 categorías (3 ingresos, 8 egresos). Fallback automático si Claude falla |

### Categorías de IA disponibles
**Ingresos:** `venta_productos`, `venta_servicios`, `otros_ingresos`

**Egresos:** `remuneraciones`, `arriendo`, `marketing`, `servicios_basicos`, `proveedores`, `impuestos`, `gastos_financieros`, `otros_gastos`

### API REST (`src/routes/documents.js`)

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/` | Health check |
| `GET` | `/api/documents/test` | Verifica que el motor esté listo |
| `POST` | `/api/documents/process` | Descarga archivo de Supabase Storage, lo procesa y guarda transacciones |
| `GET` | `/api/documents/results/:empresa_id` | Devuelve transacciones agrupadas por categoría con totales (filtros: `desde`, `hasta`, `estado`) |

#### Body de `POST /api/documents/process`
```json
{
  "archivo_id": "ruta/en/storage.xlsx",
  "empresa_id": "uuid-de-la-empresa",
  "importacion_id": "uuid-opcional",
  "bucket_name": "documentos"
}
```

### Datos de prueba
- `cartola_prueba.xlsx` — cartola bancaria de ejemplo en la raíz
- `scripts/seed_test_data.js` — inserta 20 transacciones procesadas con IA
- Empresa de prueba fija: `00000000-0000-0000-0000-000000000001`

---

## Estructura del proyecto

```
utz-backend/
├── index.js                          # Entry point — Express + rutas
├── package.json
├── .env                              # Variables de entorno (no commitear)
├── .env.example                      # Plantilla de variables
├── cartola_prueba.xlsx               # Archivo de prueba
│
├── migrations/
│   └── 001_create_tables.sql         # SQL para crear tablas en Supabase
│
├── scripts/
│   └── seed_test_data.js             # Inserta 20 transacciones de prueba
│
└── src/
    ├── routes/
    │   └── documents.js              # Endpoints /api/documents/*
    ├── controllers/                  # (vacío — lógica está en routes por ahora)
    ├── services/
    │   └── documentProcessor/
    │       ├── excelProcessor.js     # Parseo de Excel/CSV
    │       ├── pdfProcessor.js       # Parseo de PDF
    │       └── aiCategorizer.js      # Categorización con Claude
    └── utils/                        # (vacío — disponible para helpers futuros)
```

---

## Variables de entorno

Crear un archivo `.env` en la raíz (copiar desde `.env.example`):

```env
SUPABASE_URL=https://gogcmpgflhcewtwmbden.supabase.co
SUPABASE_SERVICE_KEY=<service_role key de Supabase>
ANTHROPIC_API_KEY=<API key de Anthropic/Claude>
PORT=3001
```

- `SUPABASE_SERVICE_KEY`: se obtiene en Supabase → Project Settings → API → `service_role`
- `ANTHROPIC_API_KEY`: se obtiene en console.anthropic.com

---

## Cómo correr el servidor

```bash
# Instalar dependencias (solo la primera vez)
npm install

# Desarrollo (reinicia automáticamente al guardar)
npm run dev

# Producción
npm start
```

El servidor queda disponible en `http://localhost:3001`.

**Verificar que funciona:**
```bash
curl http://localhost:3001/
curl http://localhost:3001/api/documents/test
```

**Insertar datos de prueba** (requiere tablas ya creadas en Supabase):
```bash
node scripts/seed_test_data.js
```

**Consultar resultados de prueba:**
```bash
curl http://localhost:3001/api/documents/results/00000000-0000-0000-0000-000000000001
```

---

## Estado actual — 2026-04-25

### Nuevos endpoints implementados

| Método | Endpoint | Autenticación | Descripción |
|---|---|---|---|
| `POST` | `/api/documents/process` | Bearer token | Procesa archivo. Obtiene empresa_id del token JWT |
| `GET` | `/api/resumen/:empresa_id` | No | Resumen financiero. Query: `?periodo=hoy\|semana\|mes\|año` |
| `GET` | `/api/score/:empresa_id` | No | Score UTZ (0–100). Query: `?mes=4&año=2026` |

### Middleware de autenticación (`src/middleware/auth.js`)
- Lee `Authorization: Bearer <token>`
- Valida el token contra Supabase Auth (`supabase.auth.getUser`)
- Consulta tabla `usuarios` para obtener el `empresa_id` real
- Adjunta `req.auth = { user_id, email, empresa_id }` al request

### Siguiente paso pendiente

1. **Revisión de transacciones:** Implementar `PATCH /api/documents/transactions/:id` para que el usuario corrija categorías (cambiar `estado` de `pendiente_revision` a `revisado`).

2. **Proteger resumen y score:** Si se requiere auth también en esos endpoints, agregar `authMiddleware` y leer `empresa_id` desde `req.auth`.

---

## Sesión 2026-04-26

- **Fix:** `.catch()` reemplazado por `try/catch` en `src/routes/webhooks.js`
- **Fix:** cliente Supabase usa `SUPABASE_SERVICE_KEY` para bypassear RLS
- **Fix:** `pdf-parse` downgradeado a v1.1.1 (v2.x cambió la API)
- **Fix:** búsqueda de empresa por `id` (no `owner_id`) en tabla `empresas`
- **Fix:** `aiCategorizer.js` instruye que Cargos=egreso, Abonos=ingreso, Docto. no es monto
- **Fix:** insert de transacciones uno a uno para evitar fallo total del lote
- **Estado:** 101 transacciones se guardan correctamente, pero `tipo` siempre llega como `'ingreso'`
- **Pendiente:** corregir identificación de egresos en `aiCategorizer.js`
- **Nota:** transacciones con montos inusuales son consideradas mal categorizadas, no se eliminan
