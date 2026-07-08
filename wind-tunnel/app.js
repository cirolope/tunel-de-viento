const canvas = document.getElementById('sim-canvas');
const ctx = canvas.getContext('2d');

let fluid;
let airfoilGen;
let airfoilBoundary = [];

// Settings
const config = {
    nx: 120, // grid resolution X
    ny: 60,  // grid resolution Y
    cellSize: 0,
    dt: 0.1,
    isRunning: true,
    objectType: 'airfoil',
    rotationSpeed: 0,
    naca: '2412',
    aoa: 0, // degrees
    speed: 20, // 0 to 100 mapped to fluid u
    visc: 0.0000150, // default to Air (20°C)
    vizMode: 'dye'
};

// UI Elements
const ui = {
    objectRadios: document.getElementsByName('object-type'),
    groupAirfoil: document.getElementById('group-airfoil'),
    groupCylinder: document.getElementById('group-cylinder'),
    rotationSlider: document.getElementById('rotation-slider'),
    rotationVal: document.getElementById('rotation-val'),
    nacaInput: document.getElementById('naca-input'),
    aoaSlider: document.getElementById('aoa-slider'),
    aoaVal: document.getElementById('aoa-val'),
    speedSlider: document.getElementById('speed-slider'),
    speedVal: document.getElementById('speed-val'),
    viscSelect: document.getElementById('viscosity-select'),
    vizRadios: document.getElementsByName('viz-mode'),
    btnReset: document.getElementById('btn-reset'),
    btnPause: document.getElementById('btn-pause'),
    statusBadge: document.getElementById('sim-status'),
    valLift: document.getElementById('val-lift'),
    valDrag: document.getElementById('val-drag')
};

function init() {
    airfoilGen = new AirfoilGenerator();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    fluid = new FluidGrid(config.nx, config.ny);
    setupEvents();
    updateObstacle();

    requestAnimationFrame(loop);
}

function resizeCanvas() {
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;

    // Calculate cell size based on height to keep aspect ratio
    config.cellSize = canvas.height / config.ny;
    // Adjust nx based on width
    const newNx = Math.ceil(canvas.width / config.cellSize);

    if (newNx !== config.nx && fluid) {
        config.nx = newNx;
        fluid = new FluidGrid(config.nx, config.ny);
        updateObstacle();
    }
}

function setupEvents() {
    ui.objectRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                config.objectType = e.target.value;
                if (config.objectType === 'airfoil') {
                    ui.groupAirfoil.classList.remove('hidden');
                    ui.groupCylinder.classList.add('hidden');
                } else {
                    ui.groupAirfoil.classList.add('hidden');
                    ui.groupCylinder.classList.remove('hidden');
                }
                updateObstacle();
            }
        });
    });

    ui.rotationSlider.addEventListener('input', (e) => {
        config.rotationSpeed = parseInt(e.target.value);
        ui.rotationVal.textContent = config.rotationSpeed;
        if (config.objectType === 'cylinder') updateObstacle();
    });

    ui.nacaInput.addEventListener('change', (e) => {
        let val = e.target.value;
        if (val.length === 4) {
            config.naca = val;
            updateObstacle();
        }
    });

    ui.aoaSlider.addEventListener('input', (e) => {
        config.aoa = parseFloat(e.target.value);
        ui.aoaVal.textContent = `${config.aoa}°`;
        updateObstacle();
    });

    ui.speedSlider.addEventListener('input', (e) => {
        config.speed = parseInt(e.target.value);
        ui.speedVal.textContent = config.speed;
    });

    ui.viscSelect.addEventListener('change', (e) => {
        config.visc = parseFloat(e.target.value);
    });

    ui.vizRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) config.vizMode = e.target.value;
        });
    });

    ui.btnReset.addEventListener('click', () => {
        fluid = new FluidGrid(config.nx, config.ny);
        updateObstacle();
    });

    ui.btnPause.addEventListener('click', () => {
        config.isRunning = !config.isRunning;
        ui.btnPause.textContent = config.isRunning ? 'Pause' : 'Resume';
        ui.statusBadge.innerHTML = config.isRunning ? '<span class="dot"></span> Running' : '<span class="dot" style="background:#ff4a4a; animation:none"></span> Paused';
    });
}

function updateObstacle() {
    fluid.clearObstacles();
    airfoilBoundary = [];

    // Scale and position
    // Center at 1/3 of the screen X, half screen Y
    const cx = config.nx * 0.3;
    const cy = config.ny * 0.5;

    if (config.objectType === 'airfoil') {
        const coords = airfoilGen.generate(config.naca, 60);
        const chordLen = config.nx * 0.22; // Reduced size so it doesn't look cramped

        const angleRad = -config.aoa * Math.PI / 180; // Negative because Y points down in canvas
        const cosA = Math.cos(angleRad);
        const sinA = Math.sin(angleRad);

        // First map coordinates to grid space
        for (let pt of coords) {
            // Shift origin to roughly quarter chord (0.25) for rotation
            let nx = pt.x - 0.25;
            let ny = pt.y;

            // Rotate
            let rx = nx * cosA - ny * sinA;
            let ry = nx * sinA + ny * cosA;

            // Scale and translate back
            let gx = (rx + 0.25) * chordLen + cx;
            let gy = cy - ry * chordLen; // flip Y for canvas

            airfoilBoundary.push({ x: gx, y: gy });
        }

        // Rasterize object into grid (Bounding box + Ray casting)
        let minX = config.nx, maxX = 0, minY = config.ny, maxY = 0;
        for (let pt of airfoilBoundary) {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y);
            maxY = Math.max(maxY, pt.y);
        }

        minX = Math.max(0, Math.floor(minX));
        maxX = Math.min(config.nx - 1, Math.ceil(maxX));
        minY = Math.max(0, Math.floor(minY));
        maxY = Math.min(config.ny - 1, Math.ceil(maxY));

        for (let j = minY; j <= maxY; j++) {
            for (let i = minX; i <= maxX; i++) {
                if (pointInPolygon(i, j, airfoilBoundary)) {
                    fluid.setObstacle(i, j);
                }
            }
        }
    } else if (config.objectType === 'cylinder') {
        const radius = config.ny * 0.15; // Set radius based on grid height
        const numPoints = 60;

        // Generate circular boundary for rendering
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            airfoilBoundary.push({
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius
            });
        }

        let minX = Math.max(0, Math.floor(cx - radius));
        let maxX = Math.min(config.nx - 1, Math.ceil(cx + radius));
        let minY = Math.max(0, Math.floor(cy - radius));
        let maxY = Math.min(config.ny - 1, Math.ceil(cy + radius));

        // angular velocity omega
        const maxOmega = 3.0; // Max rotation strength mapping
        const omega = (config.rotationSpeed / 100) * maxOmega;

        for (let j = minY; j <= maxY; j++) {
            for (let i = minX; i <= maxX; i++) {
                const dx = i - cx;
                const dy = j - cy;
                const dist2 = dx * dx + dy * dy;
                if (dist2 <= radius * radius) {
                    fluid.setObstacle(i, j);

                    // tangential velocity on surface
                    // u = -omega * dy, v = omega * dx
                    const u_tangent = -omega * dy;
                    const v_tangent = omega * dx;
                    fluid.setObstacleVelocity(i, j, u_tangent, v_tangent);
                }
            }
        }
    }
}

// Ray casting algorithm for point in polygon
function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        let xi = poly[i].x, yi = poly[i].y;
        let xj = poly[j].x, yj = poly[j].y;

        let intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function calculateForces() {
    // Highly approximated "forces" based on pressure field bordering the airfoil
    let lift = 0;
    let drag = 0;

    for (let j = 1; j < fluid.ny - 1; j++) {
        for (let i = 1; i < fluid.nx - 1; i++) {
            if (fluid.s[fluid.IX(i, j)] === 1) { // It's an obstacle
                // Check neighbors in fluid
                let pTop = fluid.s[fluid.IX(i, j - 1)] === 0 ? fluid.p[fluid.IX(i, j - 1)] : 0;
                let pBot = fluid.s[fluid.IX(i, j + 1)] === 0 ? fluid.p[fluid.IX(i, j + 1)] : 0;
                let pLeft = fluid.s[fluid.IX(i - 1, j)] === 0 ? fluid.p[fluid.IX(i - 1, j)] : 0;
                let pRight = fluid.s[fluid.IX(i + 1, j)] === 0 ? fluid.p[fluid.IX(i + 1, j)] : 0;

                // Lift relates to pressure difference Y (bottom pushes up minus top pushes down)
                // Actually if pBot > pTop, lift positive
                lift += (pBot - pTop);
                // Drag relates to pressure difference X (front pushes right minus back pushes left)
                drag += (pLeft - pRight);
            }
        }
    }

    // Smoothing out the readout
    const alpha = 0.1;
    let currentLift = parseFloat(ui.valLift.innerText);
    let currentDrag = parseFloat(ui.valDrag.innerText);
    if (isNaN(currentLift)) currentLift = 0;
    if (isNaN(currentDrag)) currentDrag = 0;

    ui.valLift.innerText = (currentLift * (1 - alpha) + lift * 100 * alpha).toFixed(2);
    ui.valDrag.innerText = (currentDrag * (1 - alpha) + drag * 100 * alpha).toFixed(2);
}

function loop() {
    if (config.isRunning) {
        // Map UI speed to fluid units
        let uSpeed = (config.speed / 100) * 2.0;
        fluid.step(config.dt, config.visc, 0.0, uSpeed);
        calculateForces();
    }

    draw();
    requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------------------
 * Rendering
 *
 * Field modes (dye, velocity contour, pressure) write one pixel per grid cell
 * into an offscreen canvas of size nx x ny, which is then scaled up onto the
 * visible canvas in a single drawImage call. Bilinear smoothing of the upscale
 * doubles as free interpolation between cells.
 * ------------------------------------------------------------------------- */

const fieldCanvas = document.createElement('canvas');
const fieldCtx = fieldCanvas.getContext('2d');
let fieldImage = null;

// Matches the airfoil fill color so smoothed edges blend into the outline
const OBSTACLE_RGB = [30, 31, 38];

function ensureFieldBuffer() {
    if (fieldCanvas.width !== config.nx || fieldCanvas.height !== config.ny) {
        fieldCanvas.width = config.nx;
        fieldCanvas.height = config.ny;
        fieldImage = fieldCtx.createImageData(config.nx, config.ny);
    }
}

function setCell(data, idx, r, g, b) {
    const p = idx * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
}

function renderDyeField(data) {
    for (let idx = 0; idx < fluid.numCells; idx++) {
        if (fluid.s[idx] === 1) {
            setCell(data, idx, OBSTACLE_RGB[0], OBSTACLE_RGB[1], OBSTACLE_RGB[2]);
            continue;
        }
        const c = Math.min(255, fluid.d[idx] * 255);
        setCell(data, idx, c * 0.5, c, c);
    }
}

// Max velocity magnitude over the interior (skips inlet/outlet columns)
function maxVelocityMag() {
    let maxV = 0.001;
    for (let j = 1; j < fluid.ny - 1; j++) {
        for (let i = 4; i < fluid.nx - 4; i++) {
            const idx = fluid.IX(i, j);
            if (fluid.s[idx] === 1) continue;
            const u = fluid.u[idx];
            const v = fluid.v[idx];
            const mag = Math.sqrt(u * u + v * v);
            if (mag > maxV) maxV = mag;
        }
    }
    return maxV;
}

// Jet colormap: blue -> cyan -> green -> yellow -> red for t in [0, 1]
function jetColor(t) {
    let r = 0, g = 0, b = 0;
    if (t < 0.25) {
        r = 0; g = 4 * t; b = 1;
    } else if (t < 0.5) {
        r = 0; g = 1; b = 1 - 4 * (t - 0.25);
    } else if (t < 0.75) {
        r = 4 * (t - 0.5); g = 1; b = 0;
    } else {
        r = 1; g = 1 - 4 * (t - 0.75); b = 0;
    }
    return [r * 255, g * 255, b * 255];
}

function renderContourField(data, maxV) {
    const vScale = 1.0 / maxV;
    for (let idx = 0; idx < fluid.numCells; idx++) {
        if (fluid.s[idx] === 1) {
            setCell(data, idx, OBSTACLE_RGB[0], OBSTACLE_RGB[1], OBSTACLE_RGB[2]);
            continue;
        }
        const u = fluid.u[idx];
        const v = fluid.v[idx];
        const mag = Math.sqrt(u * u + v * v);
        const t = Math.min(1.0, mag * vScale);
        const [r, g, b] = jetColor(t);
        setCell(data, idx, r, g, b);
    }
}

function renderPressureField(data) {
    // Max absolute pressure for normalization, ignoring the very edges
    let maxAbsP = 0.001;
    for (let j = 1; j < fluid.ny - 1; j++) {
        for (let i = 4; i < fluid.nx - 4; i++) {
            const idx = fluid.IX(i, j);
            if (fluid.s[idx] === 1) continue;
            const p = Math.abs(fluid.p[idx]);
            if (p > maxAbsP) maxAbsP = p;
        }
    }

    // Multiplier to make the differences more visible
    const pScale = 2.0 / maxAbsP;

    for (let idx = 0; idx < fluid.numCells; idx++) {
        if (fluid.s[idx] === 1) {
            setCell(data, idx, OBSTACLE_RGB[0], OBSTACLE_RGB[1], OBSTACLE_RGB[2]);
            continue;
        }
        const p = fluid.p[idx] * pScale;

        // Blue (negative pressure) -> White (0) -> Red (positive pressure)
        let r, g, b;
        if (p < 0) {
            const t = Math.min(1.0, -p);
            r = 255 * (1 - t);
            g = 255 * (1 - t);
            b = 255;
        } else {
            const t = Math.min(1.0, p);
            r = 255;
            g = 255 * (1 - t);
            b = 255 * (1 - t);
        }
        setCell(data, idx, r, g, b);
    }
}

function drawVelocityVectors(cs) {
    const vScale = 15; // Scale multiplier for the vector lines

    for (let j = 1; j < fluid.ny; j += 2) {
        for (let i = 1; i < fluid.nx; i += 2) {
            if (fluid.s[fluid.IX(i, j)] === 1) continue;

            let u = fluid.u[fluid.IX(i, j)];
            let v = fluid.v[fluid.IX(i, j)];
            let mag = Math.sqrt(u * u + v * v);

            // Skip very small velocities to avoid clutter
            if (mag < 0.1) continue;

            let cx = i * cs + cs / 2;
            let cy = j * cs + cs / 2;

            // Color based on magnitude (fast = bright cyan, slow = dark green/blue)
            let alpha = Math.min(1.0, mag / 2.0);
            let hue = 180 - Math.min(60, mag * 20); // shifts from Cyan (180) to Green (120) as it speeds up
            ctx.strokeStyle = `hsla(${hue}, 100%, 60%, ${alpha})`;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = 1.5;

            let endX = cx + u * vScale;
            let endY = cy + v * vScale;

            ctx.beginPath();
            // Draw the line
            ctx.moveTo(cx, cy);
            ctx.lineTo(endX, endY);
            ctx.stroke();

            // Draw a small dot at the head to indicate direction
            ctx.beginPath();
            ctx.arc(endX, endY, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawContourLegend(maxV) {
    const legW = 20;
    const legH = 200;
    const legX = 20;
    const legY = 30;

    const grad = ctx.createLinearGradient(0, legY + legH, 0, legY);
    grad.addColorStop(0, 'blue');
    grad.addColorStop(0.25, 'cyan');
    grad.addColorStop(0.5, 'lime');
    grad.addColorStop(0.75, 'yellow');
    grad.addColorStop(1, 'red');

    ctx.fillStyle = grad;
    ctx.fillRect(legX, legY, legW, legH);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(legX, legY, legW, legH);

    ctx.fillStyle = '#fff';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    for (let i = 0; i <= 5; i++) {
        let val = maxV * i / 5.0;
        let yPos = legY + legH - (i / 5.0) * legH;
        ctx.textBaseline = 'middle';
        ctx.fillText(val.toFixed(2), legX + legW + 8, yPos);
    }

    ctx.textBaseline = 'bottom';
    ctx.fillText('Velocity Mag.', legX, legY - 8);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

function drawObjectOutline(cs) {
    if (airfoilBoundary.length === 0) return;

    ctx.fillStyle = '#1e1f26';
    ctx.strokeStyle = '#9aa0a6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(airfoilBoundary[0].x * cs, airfoilBoundary[0].y * cs);
    for (let i = 1; i < airfoilBoundary.length; i++) {
        ctx.lineTo(airfoilBoundary[i].x * cs, airfoilBoundary[i].y * cs);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cs = config.cellSize;

    if (config.vizMode === 'velocity') {
        drawVelocityVectors(cs);
    } else {
        ensureFieldBuffer();
        const data = fieldImage.data;
        let maxV = 0;

        if (config.vizMode === 'dye') {
            renderDyeField(data);
        } else if (config.vizMode === 'velocity-contour') {
            maxV = maxVelocityMag();
            renderContourField(data, maxV);
        } else if (config.vizMode === 'pressure') {
            renderPressureField(data);
        }

        fieldCtx.putImageData(fieldImage, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fieldCanvas, 0, 0, config.nx * cs, config.ny * cs);

        if (config.vizMode === 'velocity-contour') {
            drawContourLegend(maxV);
        }
    }

    drawObjectOutline(cs);
}

// Start app
window.onload = init;
