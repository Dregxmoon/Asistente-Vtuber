# Observabilidad (`core/observability/`)

Logging centralizado y seguimiento de costos/tokens de LLM. Las rutas conocidas evitan registrar
claves, pero un log puede contener nombres de herramientas, errores, rutas o metadatos operativos;
debe tratarse como dato local potencialmente sensible.

## `Logger.js`

Singleton por defecto (`log`) + clase `Logger` con niveles `debug < info < warn < error`,
prefijos de scope opcionales, `setLevel`/`setQuiet` y transporte de archivo **rotativo** best-effort
(`attachFile`). En la aplicación se escribe `logs/assistant.log` bajo `userData`, con una copia
rotada `.1`; cada archivo tiene un máximo predeterminado de 5 MiB.

## `UsageTracker.js`

`class UsageTracker` + `PRICING` — agrega el uso de LLM (tokens y **costo estimado** por proveedor)
en memoria y persiste a JSONL (never-throw). `getSummary()` expone totales global / por proveedor /
de hoy, para telemetría y la Control API.

## Etiqueta

```
core/observability
        ├── Logger.js        # Logger jerárquico + attachFile rotativo
        ├── UsageTracker.js  # Tokens/costos de LLM por proveedor
        └── README.md
```

Verificación: `test_observability`.
