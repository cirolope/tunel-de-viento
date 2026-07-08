# Wind Tunnel Simulator

Simulador de túnel de viento en el navegador que resuelve un campo de fluido en tiempo real (método de fluidos estables sobre grilla Euleriana) para visualizar fenómenos aerodinámicos: sustentación, resistencia, desprendimiento de capa límite y el efecto Magnus.

Corre 100% en el cliente, sin backend ni build step: HTML, CSS y JavaScript puro sobre un `<canvas>`.

## Características

- **Dos tipos de objeto**: perfil alar NACA de 4 dígitos (configurable, ej. `2412`) o cilindro rotante (efecto Magnus).
- **Ángulo de ataque** ajustable para el perfil alar.
- **Parámetros del fluido**: velocidad del flujo y viscosidad, con presets (agua, aire, aceite de motor, glicerina, miel).
- **4 modos de visualización**: humo/tinta, campo de velocidad (vectores), contorno de velocidad (mapa de calor) y mapa de presión.
- **Lecturas en vivo** de sustentación (lift) y resistencia (drag), aproximadas a partir del campo de presión alrededor del objeto.

## Cómo usarlo

No requiere instalación ni dependencias. Alcanza con abrir el HTML directamente:

```bash
open "wind-tunnel/index.html"
```

O, si el navegador bloquea algo por CORS/rutas locales, servirlo con cualquier servidor estático:

```bash
cd wind-tunnel
python3 -m http.server 8000
# luego abrir http://localhost:8000
```

## Estructura

```
wind-tunnel/
├── index.html    # UI, controles y layout
├── app.js        # loop principal, render en canvas y manejo de eventos de UI
├── fluid.js       # solver de fluidos: advección, difusión, proyección (Poisson)
├── airfoil.js     # generador de geometría de perfiles NACA de 4 dígitos
└── styles.css     # estilos
```

## Cómo funciona

El fluido se modela sobre una grilla 2D (`FluidGrid` en `fluid.js`) siguiendo el enfoque de *Stable Fluids* (Jos Stam): en cada paso se advecta la velocidad, se difunde según la viscosidad y se proyecta el campo para que sea libre de divergencia resolviendo una ecuación de Poisson para la presión. El objeto (perfil o cilindro) se rasteriza como máscara de obstáculo dentro de esa misma grilla, y el color/vector de cada celda se pinta en el canvas según el modo de visualización elegido.

Los perfiles NACA se generan a partir de las fórmulas estándar de distribución de espesor y línea de camber para el NACA de 4 dígitos.

## Tecnología

JavaScript vanilla + HTML5 Canvas 2D. Sin frameworks, sin dependencias externas (solo tipografías vía Google Fonts CDN).
