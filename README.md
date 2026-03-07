# Mapa Interactivo de Barranquilla

Un proyecto web de código abierto que muestra un mapa interactivo de la ciudad de Barranquilla, Colombia, con tema oscuro y alto contraste.

## Características

✨ **Mapa Interactivo**
- Centrado en la ciudad de Barranquilla
- Limites de zoom configurados para mantener el enfoque en la ciudad
- Navegación suave y responsiva

🎨 **Tema Dark Mode**
- Interfaz oscura con alto contraste
- Colores de neón: verde (#00FF88) y cian (#00CCFF)
- Tema alternativo de alto contraste disponible

📍 **Puntos de Interés**
- 8 puntos de interés principales incluidos
- Marcadores personalizados con glow effects
- Información emergente detallada de cada ubicación

🛠️ **Herramientas**
- Botón de centrado rápido del mapa
- Alternancia de modo alto contraste
- Visualización en tiempo real de coordenadas y zoom

📱 **Responsive**
- Compatible con dispositivos móviles
- Interfaz adaptable a diferentes tamaños de pantalla

## Stack Tecnológico

- **Leaflet.js** - Librería de mapas interactivos de código abierto
- **OpenStreetMap** - Datos cartográficos de código abierto
- **HTML5, CSS3, Vanilla JavaScript**

## Instalación

### Opción 1: Usar con Python (Recomendado para desarrollo)

```bash
# Instalar dependencias (opcional, solo para desarrollo)
npm install

# Ejecutar servidor local
npm start
# o
python -m http.server 8000
```

Luego abre `http://localhost:8000` en tu navegador.

### Opción 2: Abrir directamente

Simplemente abre el archivo `index.html` en tu navegador web. No requiere instalación de servidor.

## Uso

### Navegación del Mapa
- **Arrastrar** - Mover el mapa
- **Rueda del ratón** - Zoom in/out
- **Botones de zoom** - Controles en la esquina superior izquierda
- **Click en marcadores** - Ver información de puntos de interés

### Controles
- **Centrar Mapa** - Vuelve a Barranquilla al centro
- **Alternar Contraste** - Cambia a modo alto contraste
- **Panel de Información** - Muestra coordenadas actuales y nivel de zoom

## Estructura del Proyecto

```
mi-mapa-barranquilla/
├── index.html       # Archivo HTML principal
├── styles.css       # Estilos CSS (tema dark + responsive)
├── map.js           # Lógica del mapa y eventos
├── package.json     # Configuración del proyecto
└── README.md        # Este archivo
```

## Puntos de Interés Incluidos

1. **Centro de Barranquilla** - Centro histórico de la ciudad
2. **Paseo de Colón** - Monumento icónico
3. **Botánico Guillermo Piñeres** - Jardín botánico
4. **Museo del Atlántico** - Museo de arte y cultura
5. **Catedral Metropolitana** - Catedral de la ciudad
6. **Estadio Metropolitano** - Principal estadio
7. **Puerto de Barranquilla** - Puerto comercial
8. **Playa de Barranquilla** - Acceso al mar Caribe

## Personalización

### Agregar Nuevos Puntos de Interés

Edita el array `POINTS_OF_INTEREST` en `map.js`:

```javascript
const POINTS_OF_INTEREST = [
    {
        lat: 10.9639,
        lng: -74.7964,
        name: 'Nombre del Lugar',
        description: 'Descripción del lugar'
    },
    // Agregar más puntos...
];
```

### Cambiar Colores

Edita las variables CSS en la sección `:root` de `styles.css`:

```css
:root {
    --accent-primary: #00ff88;      /* Verde neon */
    --accent-secondary: #00ccff;    /* Cian */
    /* ... más colores ... */
}
```

### Ajustar Área del Mapa

Modifica `BARRANQUILLA` y el radio del círculo en `map.js`:

```javascript
const BARRANQUILLA = {
    lat: 10.9639,
    lng: -74.7964,
    name: 'Barranquilla, Colombia'
};

const radius = 5000; // en metros
```

## Compatibilidad

- ✅ Chrome/Chromium (v90+)
- ✅ Firefox (v88+)
- ✅ Safari (v14+)
- ✅ Edge (v90+)
- ✅ Navegadores móviles (iOS Safari, Chrome Mobile)

## Licencia

MIT License - Libre para usar, modificar y distribuir

## Créditos

- **Leaflet.js** - https://leafletjs.com/
- **OpenStreetMap** - https://www.openstreetmap.org/
- Mapas y datos cartográficos: © OpenStreetMap contributors

## Contribuciones

Las contribuciones son bienvenidas. Para reportar bugs o sugerir features, por favor abre un issue.

## Autor

Proyecto de Mapa Interactivo - 2026

---

**Nota**: Este proyecto utiliza servicios web abiertos. Asegúrate de revisar las políticas de uso de OpenStreetMap y Leaflet.
