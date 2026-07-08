# Wind Tunnel Simulator

Simulador de túnel de viento en el navegador que resuelve un campo de fluido en tiempo real (método de fluidos estables sobre grilla Euleriana) para visualizar fenómenos aerodinámicos: sustentación, resistencia, desprendimiento de capa límite y el efecto Magnus.

Corre 100% en el cliente, sin backend ni build step: HTML, CSS y JavaScript puro sobre un `<canvas>`.

## Características

- **Dos tipos de objeto**: perfil alar NACA de 4 dígitos (configurable, ej. `2412`) o cilindro rotante (efecto Magnus).
- **Objeto arrastrable**: se puede reposicionar el perfil o cilindro dentro del túnel arrastrándolo con el mouse (o el dedo en pantallas táctiles).
- **Ángulo de ataque** ajustable para el perfil alar (-20° a +20°).
- **Barrido de ángulo de ataque**: un botón recorre automáticamente el rango de ángulos, deja asentar el flujo en cada uno y grafica las curvas de sustentación y resistencia vs. ángulo, marcando el punto de entrada en pérdida (stall) si aparece.
- **Parámetros del fluido**: velocidad del flujo (en m/s) y viscosidad cinemática, con presets (agua, aire, aceite de motor, glicerina, miel).
- **Número de Reynolds en vivo**, calculado como Re = U·c/ν con cuerda de referencia de 1 m.
- **5 modos de visualización**: humo/tinta, partículas trazadoras con estelas (como los hilos de humo de un túnel real), campo de velocidad (vectores), contorno de velocidad (mapa de calor) y mapa de presión.
- **Lecturas en vivo** de sustentación (lift) y resistencia (drag), aproximadas a partir del campo de presión alrededor del objeto (unidades arbitrarias).
- **Configuración compartible por URL**: el setup completo (perfil, ángulo, velocidad, fluido, modo de visualización) se refleja en el query string — copiá la barra de direcciones para compartirlo.
- **Simulación con paso de tiempo fijo** (60 pasos/s), independiente del refresh rate del monitor.
- **Accesible por teclado** y con layout responsive (el panel de controles se apila debajo del canvas en pantallas angostas).

## Cómo usarlo

No requiere instalación ni dependencias. Alcanza con abrir el HTML directamente:

```bash
open "wind-tunnel/index.html"
```

Para que funcione el compartir por URL, conviene servirlo con cualquier servidor estático:

```bash
cd wind-tunnel
python3 -m http.server 8000
# luego abrir http://localhost:8000
```

Ejemplo de configuración compartida:

```
http://localhost:8000/?obj=cylinder&rot=60&speed=45&viz=pressure
```

## Estructura

```
wind-tunnel/
├── index.html    # UI, controles y layout
├── app.js        # loop principal, renderers por modo, partículas y manejo de UI
├── fluid.js       # solver de fluidos: advección, difusión, proyección (Poisson)
├── airfoil.js     # generador de geometría de perfiles NACA de 4 dígitos
└── styles.css     # estilos
```

## Cómo funciona

El fluido se modela sobre una grilla 2D (`FluidGrid` en `fluid.js`) siguiendo el enfoque de *Stable Fluids* (Jos Stam): en cada paso se advecta la velocidad, se difunde según la viscosidad y se proyecta el campo para que sea libre de divergencia resolviendo una ecuación de Poisson para la presión. El objeto (perfil o cilindro) se rasteriza como máscara de obstáculo dentro de esa misma grilla.

Para que se formen y sostengan los vórtices (que la advección semi-lagrangiana normalmente disipa) se agregan tres cosas: **confinamiento de vorticidad** (Fedkiw et al. 2001), que reinyecta el remolino de pequeña escala perdido por la difusión numérica; **advección MacCormack del tinte**, un esquema de segundo orden mucho menos difusivo que hace que el humo enrolle los vórtices en vez de emborronarlos; y una pequeña perturbación en la entrada que rompe la simetría para que el desprendimiento (calle de von Kármán) arranque. El resultado: estela turbulenta detrás del cilindro y separación de capa límite sobre el perfil en pérdida. A mayor velocidad, mayor vorticidad y flujo más turbulento; a baja velocidad, más laminar.

Los modos de campo (humo, contorno, presión) se renderizan escribiendo un píxel por celda en un canvas offscreen de la resolución de la grilla, que luego se escala al canvas visible en una sola operación (el suavizado bilineal del escalado interpola entre celdas). Las partículas trazadoras se advectan muestreando el campo de velocidad con interpolación bilineal y dejan estelas sobre un buffer persistente con desvanecimiento gradual.

Los perfiles NACA se generan a partir de las fórmulas estándar de distribución de espesor y línea de camber para el NACA de 4 dígitos. La sustentación y la resistencia se obtienen integrando la presión alrededor de la superficie del objeto; sobre eso, un modelo de separación de capa límite dependiente del ángulo hace caer la sustentación y disparar la resistencia de forma más allá del ángulo crítico, para reproducir la entrada en pérdida (stall) — que a esta resolución no emerge sola de forma limpia.

**Nota física**: es una simulación cualitativa en tiempo real, no un solver de CFD. A la resolución de grilla usada (~120×60) la difusión numérica domina sobre la viscosidad real de fluidos poco viscosos — agua y aire se comportan de forma casi idéntica (ambos efectivamente no viscosos a esta escala, como refleja su Reynolds altísimo); solo los fluidos muy viscosos (glicerina, miel) muestran diferencias claras. Los vórtices y el stall son fenomenológicamente correctos pero no cuantitativos.

## Tecnología

JavaScript vanilla + HTML5 Canvas 2D. Sin frameworks, sin dependencias externas (solo tipografías vía Google Fonts CDN).
