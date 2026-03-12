# Supabase Setup

Este proyecto ya no usa Firebase.

## 1) Crear proyecto en Supabase
- Crea un proyecto en https://supabase.com/dashboard.
- Copia `Project URL` y `anon public key`.

## 2) Crear tablas y policies
- Abre el SQL Editor de Supabase.
- Ejecuta el contenido de `supabase-schema.sql`.

## 3) Configurar cliente frontend
Edita `supabase-config.js` y reemplaza:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## 4) Levantar el proyecto
```bash
npm install
npm start
```

## Notas
- Si no configuras `supabase-config.js`, la app funciona en modo local (sin persistencia remota).
- La escritura (crear/editar/eliminar) usa policies para usuarios autenticados.
- El login del modal usa `supabase.auth.signInWithPassword`.
