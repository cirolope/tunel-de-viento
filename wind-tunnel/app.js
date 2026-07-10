const canvas = document.getElementById('sim-canvas');
const ctx = canvas.getContext('2d');

let fluid;
let airfoilGen;
let airfoilBoundary = [];

// Settings
const config = {
    nx: 160, // grid resolution X
    ny: 80,  // grid resolution Y
    cellSize: 0,
    dt: 0.1,
    isRunning: true,
    objectType: 'airfoil',
    rotationSpeed: 0,
    naca: '2412',
    aoa: 0, // degrees
    speed: 20, // 0 to 100 mapped to fluid u
    visc: 0.0000150, // default to Air (20°C)
    vizMode: 'velocity-contour',
    objXFrac: 0.3, // object center as a fraction of the grid (draggable)
    objYFrac: 0.5
};

// Keep the object clear of the inlet columns and the domain edges
const OBJ_X_RANGE = [0.15, 0.7];
const OBJ_Y_RANGE = [0.25, 0.75];

// UI Elements
const ui = {
    objectRadios: document.getElementsByName('object-type'),
    groupAirfoil: document.getElementById('group-airfoil'),
    groupCylinder: document.getElementById('group-cylinder'),
    rotationSlider: document.getElementById('rotation-slider'),
    rotationVal: document.getElementById('rotation-val'),
    nacaInput: document.getElementById('naca-input'),
    nacaError: document.getElementById('naca-error'),
    aoaSlider: document.getElementById('aoa-slider'),
    aoaVal: document.getElementById('aoa-val'),
    speedSlider: document.getElementById('speed-slider'),
    speedVal: document.getElementById('speed-val'),
    viscSelect: document.getElementById('viscosity-select'),
    vizRadios: document.getElementsByName('viz-mode'),
    btnReset: document.getElementById('btn-reset'),
    btnPause: document.getElementById('btn-pause'),
    btnSweep: document.getElementById('btn-sweep'),
    statusBadge: document.getElementById('sim-status'),
    valLift: document.getElementById('val-lift'),
    valDrag: document.getElementById('val-drag'),
    valRe: document.getElementById('val-re'),
    chartOverlay: document.getElementById('chart-overlay'),
    chartClose: document.getElementById('chart-close'),
    chartCanvas: document.getElementById('lift-chart'),
    chartNote: document.getElementById('chart-note'),
    sweepStatus: document.getElementById('sweep-status'),
    hudPause: document.getElementById('hud-pause'),
    hudNaca: document.getElementById('hud-naca'),
    hudAoa: document.getElementById('hud-aoa'),
    miniLift: document.getElementById('mini-lift')
};

const miniCtx = ui.miniLift.getContext('2d');

// Reynolds number for a reference chord of 1 m, with the speed slider read
// as airspeed in m/s and the select as kinematic viscosity in m²/s.
const REFERENCE_CHORD_M = 1;

function formatReynolds(re) {
    if (re >= 1e6) return (re / 1e6).toFixed(1) + 'M';
    if (re >= 1e3) return (re / 1e3).toFixed(1) + 'k';
    return Math.round(re).toString();
}

function updateReynolds() {
    const re = config.speed * REFERENCE_CHORD_M / config.visc;
    ui.valRe.textContent = formatReynolds(re);
}

function init() {
    airfoilGen = new AirfoilGenerator();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    fluid = new FluidGrid(config.nx, config.ny);
    applyURLParams();
    setupEvents();
    updateObstacle();
    updateReynolds();
    resetParticles();

    requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------------------
 * Shareable URLs: the tunnel setup is mirrored to the query string, so any
 * configuration can be shared by copying the address bar.
 * ------------------------------------------------------------------------- */

const VIZ_MODES = ['dye', 'particles', 'velocity', 'velocity-contour', 'pressure'];

function applyURLParams() {
    const q = new URLSearchParams(location.search);
    const num = (key, min, max) => {
        const v = parseFloat(q.get(key));
        return isNaN(v) ? null : Math.max(min, Math.min(max, v));
    };

    if (/^\d{4}$/.test(q.get('naca') || '')) {
        config.naca = q.get('naca');
        ui.nacaInput.value = config.naca;
    }

    const aoa = num('aoa', -20, 20);
    if (aoa !== null) {
        config.aoa = Math.round(aoa);
        ui.aoaSlider.value = config.aoa;
        ui.aoaVal.textContent = `${config.aoa}°`;
    }

    const speed = num('speed', 0, 100);
    if (speed !== null) {
        config.speed = Math.round(speed);
        ui.speedSlider.value = config.speed;
        ui.speedVal.textContent = config.speed;
    }

    const rot = num('rot', -100, 100);
    if (rot !== null) {
        config.rotationSpeed = Math.round(rot);
        ui.rotationSlider.value = config.rotationSpeed;
        ui.rotationVal.textContent = config.rotationSpeed;
    }

    const visc = num('visc', 0, 1);
    if (visc !== null) {
        for (const opt of ui.viscSelect.options) {
            if (parseFloat(opt.value) === visc) {
                config.visc = visc;
                ui.viscSelect.value = opt.value;
                break;
            }
        }
    }

    const obj = q.get('obj');
    if (obj === 'airfoil' || obj === 'cylinder') {
        config.objectType = obj;
        document.querySelector(`input[name="object-type"][value="${obj}"]`).checked = true;
        ui.groupAirfoil.classList.toggle('hidden', obj !== 'airfoil');
        ui.groupCylinder.classList.toggle('hidden', obj !== 'cylinder');
    }

    const viz = q.get('viz');
    if (VIZ_MODES.includes(viz)) {
        config.vizMode = viz;
        document.querySelector(`input[name="viz-mode"][value="${viz}"]`).checked = true;
    }

    const ox = num('objx', OBJ_X_RANGE[0], OBJ_X_RANGE[1]);
    if (ox !== null) config.objXFrac = ox;
    const oy = num('objy', OBJ_Y_RANGE[0], OBJ_Y_RANGE[1]);
    if (oy !== null) config.objYFrac = oy;
}

function syncURL() {
    const q = new URLSearchParams({
        obj: config.objectType,
        naca: config.naca,
        aoa: config.aoa,
        speed: config.speed,
        visc: config.visc,
        rot: config.rotationSpeed,
        viz: config.vizMode,
        objx: config.objXFrac.toFixed(3),
        objy: config.objYFrac.toFixed(3)
    });
    try {
        history.replaceState(null, '', '?' + q.toString());
    } catch (e) {
        // file:// may not allow replaceState; sharing only works when served
    }
}

function resizeCanvas() {
    const parent = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;

    // Backing store at device resolution, drawing coordinates in CSS pixels
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Calculate cell size based on height to keep aspect ratio
    config.cellSize = cssH / config.ny;
    // Adjust nx based on width
    const newNx = Math.ceil(cssW / config.cellSize);

    if (newNx !== config.nx && fluid) {
        const oldFluid = fluid;
        config.nx = newNx;
        fluid = new FluidGrid(config.nx, config.ny);
        fluid.copyFieldsFrom(oldFluid);
        updateObstacle();
    }
}

function setupEvents() {
    // Mirror any control change into the query string (event delegation)
    const panel = document.querySelector('.controls-panel');
    panel.addEventListener('input', syncURL);
    panel.addEventListener('change', syncURL);

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
                syncHud();
                updateObstacle();
            }
        });
    });

    ui.rotationSlider.addEventListener('input', (e) => {
        config.rotationSpeed = parseInt(e.target.value);
        ui.rotationVal.textContent = config.rotationSpeed;
        syncHud();
        if (config.objectType === 'cylinder') updateObstacle();
    });

    const setNacaValidity = (valid) => {
        ui.nacaInput.classList.toggle('invalid', !valid);
        ui.nacaError.classList.toggle('hidden', valid);
    };

    ui.nacaInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (/^\d{4}$/.test(val)) {
            setNacaValidity(true);
            if (val !== config.naca) {
                config.naca = val;
                syncHud();
                updateObstacle();
            }
        } else {
            // While typing, only flag clearly wrong input (non-digits);
            // an incomplete number is flagged on blur
            setNacaValidity(!/\D/.test(val));
        }
    });

    ui.nacaInput.addEventListener('blur', (e) => {
        setNacaValidity(/^\d{4}$/.test(e.target.value));
    });

    ui.aoaSlider.addEventListener('input', (e) => {
        config.aoa = parseFloat(e.target.value);
        ui.aoaVal.textContent = `${config.aoa}°`;
        syncHud();
        updateObstacle();
    });

    ui.speedSlider.addEventListener('input', (e) => {
        config.speed = parseInt(e.target.value);
        ui.speedVal.textContent = config.speed;
        updateReynolds();
    });

    ui.viscSelect.addEventListener('change', (e) => {
        config.visc = parseFloat(e.target.value);
        updateReynolds();
    });

    ui.vizRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                config.vizMode = e.target.value;
                if (config.vizMode === 'particles') resetParticles();
            }
        });
    });

    ui.btnReset.addEventListener('click', () => {
        fluid = new FluidGrid(config.nx, config.ny);
        updateObstacle();
        resetParticles();
    });

    ui.btnPause.addEventListener('click', () => setRunning(!config.isRunning));
    ui.hudPause.addEventListener('click', () => setRunning(!config.isRunning));

    ui.btnSweep.addEventListener('click', runSweep);
    ui.chartClose.addEventListener('click', () => ui.chartOverlay.classList.add('hidden'));
    ui.chartCanvas.addEventListener('pointermove', onChartHover);
    ui.chartCanvas.addEventListener('pointerleave', () => renderLiftCurve(-1));

    document.addEventListener('keydown', onKeyDown);
    setupDrag();
    syncHud();
}

// Play/pause in one place so the side button, the HUD chip and the spacebar
// all stay in sync.
function setRunning(state) {
    config.isRunning = state;
    ui.btnPause.textContent = state ? 'Pause' : 'Resume';
    ui.hudPause.textContent = state ? '⏸ pause' : '▶ play';
    ui.statusBadge.innerHTML = state
        ? '<span class="dot"></span> Running'
        : '<span class="dot" style="background:#ff4a4a; animation:none"></span> Paused';
}

// Advance the simulation exactly one step while paused (the reel's "N" key).
function stepOnce() {
    const uSpeed = (config.speed / 100) * 2.0;
    fluid.step(config.dt, config.visc, 0.0, uSpeed);
    if (config.vizMode === 'particles') updateParticles(config.dt);
    if (config.vizMode === 'velocity-contour' || config.vizMode === 'velocity') updateStreak(config.dt);
    calculateForces();
}

// Mirror the live tunnel state into the reel-style toolbar chips.
function syncHud() {
    ui.hudNaca.textContent = config.naca;
    ui.hudNaca.style.display = config.objectType === 'airfoil' ? '' : 'none';
    ui.hudAoa.textContent = config.objectType === 'airfoil'
        ? `α ${config.aoa}°`
        : `⟳ ${config.rotationSpeed}`;
}

function onKeyDown(e) {
    // Don't hijack typing in the NACA box etc.
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    switch (e.key) {
        case ' ':
            e.preventDefault();
            setRunning(!config.isRunning);
            break;
        case 'n': case 'N':
            if (!config.isRunning) { stepOnce(); }
            break;
        case 'r': case 'R':
            fluid = new FluidGrid(config.nx, config.ny);
            updateObstacle();
            resetParticles();
            break;
        case 's': case 'S':
            runSweep();
            break;
        case 'ArrowUp':
            e.preventDefault();
            setAoa(config.aoa + 1);
            break;
        case 'ArrowDown':
            e.preventDefault();
            setAoa(config.aoa - 1);
            break;
        case '1': case '2': case '3': case '4': case '5': {
            const mode = VIZ_MODES[parseInt(e.key, 10) - 1];
            if (mode) selectVizMode(mode);
            break;
        }
    }
}

// Set AoA from code (keyboard) and keep the slider + chips in sync.
function setAoa(deg) {
    if (config.objectType !== 'airfoil') return;
    config.aoa = clamp(deg, -20, 20);
    ui.aoaSlider.value = config.aoa;
    ui.aoaVal.textContent = `${config.aoa}°`;
    syncHud();
    updateObstacle();
    syncURL();
}

// Switch visualization from code (keyboard) and tick the matching radio.
function selectVizMode(mode) {
    config.vizMode = mode;
    ui.vizRadios.forEach(r => { r.checked = (r.value === mode); });
    if (mode === 'particles') resetParticles();
    syncURL();
}

/* ---------------------------------------------------------------------------
 * Dragging the object
 *
 * The object can be repositioned by dragging it across the tunnel. Positions
 * are stored as grid fractions so they survive resizes, and clamped to keep
 * the object clear of the inlet and the walls.
 * ------------------------------------------------------------------------- */

let isDragging = false;
let dragOffsetX = 0; // grid-units between object center and pointer at grab
let dragOffsetY = 0;

function pointerToGrid(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        gx: (e.clientX - rect.left) / config.cellSize,
        gy: (e.clientY - rect.top) / config.cellSize
    };
}

function overObject(gx, gy) {
    if (!objBounds) return false;
    const pad = 2; // generous grab margin
    return gx >= objBounds.minX - pad && gx <= objBounds.maxX + pad &&
        gy >= objBounds.minY - pad && gy <= objBounds.maxY + pad;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function setupDrag() {
    canvas.addEventListener('pointerdown', (e) => {
        const { gx, gy } = pointerToGrid(e);
        if (!overObject(gx, gy)) return;

        isDragging = true;
        dragOffsetX = config.nx * config.objXFrac - gx;
        dragOffsetY = config.ny * config.objYFrac - gy;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        canvas.style.touchAction = 'none'; // don't scroll the page while dragging
        e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
        const { gx, gy } = pointerToGrid(e);

        if (!isDragging) {
            canvas.style.cursor = overObject(gx, gy) ? 'grab' : 'crosshair';
            return;
        }

        config.objXFrac = clamp((gx + dragOffsetX) / config.nx, OBJ_X_RANGE[0], OBJ_X_RANGE[1]);
        config.objYFrac = clamp((gy + dragOffsetY) / config.ny, OBJ_Y_RANGE[0], OBJ_Y_RANGE[1]);
        updateObstacle();
        e.preventDefault();
    });

    const endDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        canvas.style.cursor = 'grab';
        canvas.style.touchAction = '';
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        syncURL();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
}

// Grid-space bounding box of the current object, for pointer hit-testing
let objBounds = null;

function updateObstacle() {
    fluid.clearObstacles();
    airfoilBoundary = [];

    // Object center, positioned as a fraction of the grid (draggable)
    const cx = config.nx * config.objXFrac;
    const cy = config.ny * config.objYFrac;

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

        objBounds = { minX, maxX, minY, maxY };

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

        objBounds = { minX, maxX, minY, maxY };

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

// Smoothed force readouts (arbitrary units), kept in JS instead of
// round-tripping through the DOM text
const forces = { lift: 0, drag: 0 };

// Highly approximated "forces" from the pressure field bordering the object,
// in the same arbitrary units used by the readout.
function computeRawForces() {
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

                // Lift: pressure difference in Y (bottom pushes up minus top down)
                lift += (pBot - pTop);
                // Drag: pressure difference in X (front pushes right minus back left)
                drag += (pLeft - pRight);
            }
        }
    }

    return { lift: lift * 100, drag: drag * 100 };
}

// Boundary-layer separation / stall model.
//
// The pressure integration alone keeps building lift with angle: at this grid
// resolution the flow never cleanly separates, so there is no stall. Real wings
// stall because the boundary layer on the suction side detaches past a critical
// angle, collapsing the lift and spiking the (form) drag. We model that with a
// smooth separation fraction driven by angle of attack, applied on top of the
// physically-integrated pressure force.
const STALL_ONSET_DEG = 12;
const STALL_FULL_DEG = 22;

function separationFraction(aoaDeg) {
    const a = Math.abs(aoaDeg);
    if (a <= STALL_ONSET_DEG) return 0;
    let t = (a - STALL_ONSET_DEG) / (STALL_FULL_DEG - STALL_ONSET_DEG);
    if (t > 1) t = 1;
    return t * t * (3 - 2 * t); // smoothstep
}

function aeroForces() {
    const raw = computeRawForces();
    if (config.objectType !== 'airfoil') return raw;

    const sep = separationFraction(config.aoa);
    return {
        lift: raw.lift * (1 - 0.75 * sep),                 // lift collapses at stall
        drag: raw.drag + sep * Math.abs(raw.lift) * 0.6    // form drag jumps at stall
    };
}

function calculateForces() {
    const raw = aeroForces();

    // Exponential smoothing of the readout
    const alpha = 0.1;
    forces.lift = forces.lift * (1 - alpha) + raw.lift * alpha;
    forces.drag = forces.drag * (1 - alpha) + raw.drag * alpha;

    ui.valLift.textContent = forces.lift.toFixed(2);
    ui.valDrag.textContent = forces.drag.toFixed(2);
}

// Fixed-timestep loop: the simulation always advances SIM_HZ steps per real
// second regardless of the display refresh rate (60 vs 144 Hz monitors).
const SIM_HZ = 60;
const SIM_STEP = 1 / SIM_HZ;   // seconds of real time per simulation step
const MAX_STEPS_PER_FRAME = 4; // drop backlog instead of spiraling when slow

let lastFrameTime = null;
let timeAccumulator = 0;

function loop(now) {
    if (lastFrameTime === null) lastFrameTime = now;
    let elapsed = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    // Ignore long gaps (background tab, breakpoints)
    if (elapsed > 0.25) elapsed = 0.25;

    if (config.isRunning && !sweeping) {
        timeAccumulator += elapsed;
        let steps = 0;
        while (timeAccumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
            // Map UI speed to fluid units
            let uSpeed = (config.speed / 100) * 2.0;
            fluid.step(config.dt, config.visc, 0.0, uSpeed);
            if (config.vizMode === 'particles') updateParticles(config.dt);
            timeAccumulator -= SIM_STEP;
            steps++;
        }
        if (timeAccumulator > SIM_STEP) timeAccumulator = SIM_STEP;
        if (steps > 0) {
            calculateForces();
            // Drift the flow texture only for the views that use it
            if (config.vizMode === 'velocity-contour' || config.vizMode === 'velocity') {
                updateStreak(config.dt * Math.min(steps, 2));
            }
        }
    } else {
        timeAccumulator = 0;
    }

    draw();
    requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------------------
 * Tracer particles
 *
 * Massless particles advected by the velocity field, drawn with fading
 * trails on a persistent overlay canvas — like smoke filaments in a real
 * wind tunnel. Positions are in grid coordinates.
 * ------------------------------------------------------------------------- */

const NUM_PARTICLES = 700;
const particleX = new Float32Array(NUM_PARTICLES);
const particleY = new Float32Array(NUM_PARTICLES);
// Previous position, so each frame draws a continuous segment (filament)
const particlePX = new Float32Array(NUM_PARTICLES);
const particlePY = new Float32Array(NUM_PARTICLES);

const trailCanvas = document.createElement('canvas');
const trailCtx = trailCanvas.getContext('2d');

function seedParticle(i, anywhere) {
    particleX[i] = anywhere ? Math.random() * (config.nx - 2) + 1 : 1 + Math.random() * 2;
    particleY[i] = 1 + Math.random() * (config.ny - 2);
    particlePX[i] = particleX[i];
    particlePY[i] = particleY[i];
}

function resetParticles() {
    for (let i = 0; i < NUM_PARTICLES; i++) seedParticle(i, true);
    clearTrails();
}

function clearTrails() {
    trailCtx.setTransform(1, 0, 0, 1, 0, 0);
    trailCtx.fillStyle = '#0a0a0c';
    trailCtx.fillRect(0, 0, trailCanvas.width, trailCanvas.height);
}

// Bilinear sample of the velocity field at fractional grid coords
function sampleVelocity(x, y) {
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const s1 = x - i0, s0 = 1 - s1;
    const t1 = y - j0, t0 = 1 - t1;

    const a = fluid.IX(i0, j0), b = fluid.IX(i0 + 1, j0);
    const c = fluid.IX(i0, j0 + 1), d = fluid.IX(i0 + 1, j0 + 1);

    return {
        u: s0 * (t0 * fluid.u[a] + t1 * fluid.u[c]) + s1 * (t0 * fluid.u[b] + t1 * fluid.u[d]),
        v: s0 * (t0 * fluid.v[a] + t1 * fluid.v[c]) + s1 * (t0 * fluid.v[b] + t1 * fluid.v[d])
    };
}

function updateParticles(dt) {
    // Same velocity-to-cells scaling used by the advection step
    const dt0x = dt * (config.nx - 2);
    const dt0y = dt * (config.ny - 2);

    for (let i = 0; i < NUM_PARTICLES; i++) {
        particlePX[i] = particleX[i];
        particlePY[i] = particleY[i];

        const vel = sampleVelocity(particleX[i], particleY[i]);
        particleX[i] += vel.u * dt0x;
        particleY[i] += vel.v * dt0y;

        const gx = Math.round(particleX[i]);
        const gy = Math.round(particleY[i]);
        const out = particleX[i] >= config.nx - 1 || particleX[i] < 0 ||
            particleY[i] <= 0 || particleY[i] >= config.ny - 1;
        if (out || fluid.s[fluid.IX(gx, gy)] === 1) {
            seedParticle(i, false);
        }
    }
}

function drawParticles(cs) {
    const dpr = window.devicePixelRatio || 1;

    if (trailCanvas.width !== canvas.width || trailCanvas.height !== canvas.height) {
        trailCanvas.width = canvas.width;
        trailCanvas.height = canvas.height;
        clearTrails();
    }

    if (config.isRunning) {
        trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Fade previous frame slightly to leave trails
        trailCtx.fillStyle = 'rgba(10, 10, 12, 0.14)';
        trailCtx.fillRect(0, 0, trailCanvas.width, trailCanvas.height);

        // One stroke with all segments: previous -> current position
        trailCtx.strokeStyle = 'rgba(170, 255, 240, 0.55)';
        trailCtx.lineWidth = 1;
        trailCtx.beginPath();
        for (let i = 0; i < NUM_PARTICLES; i++) {
            trailCtx.moveTo(particlePX[i] * cs, particlePY[i] * cs);
            trailCtx.lineTo(particleX[i] * cs + 0.3, particleY[i] * cs + 0.3);
        }
        trailCtx.stroke();
    }

    // Blit the trail buffer 1:1 in device pixels
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(trailCanvas, 0, 0);
    ctx.restore();
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

// Turbo colormap (Google, Anton Mikhailov) via its published polynomial
// approximation. Perceptually smoother than jet and gives the deep-blue →
// teal → green → yellow → red range that reads as a proper CFD velocity map.
function turboColor(t) {
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const r = 34.61 + t * (1172.33 + t * (-10793.56 + t * (33300.12 + t * (-38394.49 + t * 14825.05))));
    const g = 23.31 + t * (557.33 + t * (1225.33 + t * (-3574.96 + t * (1073.77 + t * 707.56))));
    const b = 27.20 + t * (3211.10 + t * (-15327.97 + t * (27814.00 + t * (-22569.18 + t * 6838.66))));
    return [r, g, b];
}

// Freestream velocity in the solver's units (mirrors the drive in loop()).
function freestreamSpeed() {
    return Math.max(0.2, (config.speed / 100) * 2.0);
}

// Full-scale velocity for the colour map. Normalising to a fixed multiple of
// the freestream (rather than the flickering field maximum) keeps the colours
// steady: undisturbed flow sits green, the suction peak over the airfoil runs
// yellow→red, and stagnation / wake fall to blue — the stable reading a real
// tunnel view gives.
function contourReference() {
    // Lower multiple than a plain "2x freestream" so the suction peak over the
    // airfoil saturates to red (as in the reference reel) while the undisturbed
    // stream still sits green and the wake falls to deep blue.
    return freestreamSpeed() * 2.05;
}

/* ---------------------------------------------------------------------------
 * High-resolution flow texture (the "silky fibres" look)
 *
 * The velocity view is rendered on a grid SS times finer than the physics grid.
 * A noise field is advected through the (bilinearly sampled) velocity, which
 * stretches it into fine hair-like streaklines aligned with the flow — a cheap
 * Line-Integral-Convolution. The Turbo colour comes from the same interpolated
 * velocity, so colour stays smooth while the fibres stay crisp.
 * ------------------------------------------------------------------------- */

const SS = 2;                 // texture supersampling factor
const INJECT = 0.10;          // fraction of fresh noise blended in per frame (IBFV)
const hiCanvas = document.createElement('canvas');
const hiCtx = hiCanvas.getContext('2d');
let hiImage = null;
let sx = 0, sy = 0;           // hi-res texture dimensions
let streak = null, streak0 = null;

function ensureHiRes() {
    const w = config.nx * SS, h = config.ny * SS;
    if (sx === w && sy === h && streak) return;
    sx = w; sy = h;
    streak = new Float32Array(sx * sy);
    streak0 = new Float32Array(sx * sy);
    for (let k = 0; k < streak.length; k++) streak[k] = Math.random();
    hiCanvas.width = sx;
    hiCanvas.height = sy;
    hiImage = hiCtx.createImageData(sx, sy);
}

// Advect the fine noise through the flow (semi-Lagrangian) and re-seed, so the
// fibres continually stream in instead of smearing to grey.
function updateStreak(dtEff) {
    ensureHiRes();
    const nx = config.nx, ny = config.ny, u = fluid.u, v = fluid.v;
    const dt0x = dtEff * (nx - 2) * SS;
    const dt0y = dtEff * (ny - 2) * SS;
    streak0.set(streak);

    for (let J = 0; J < sy; J++) {
        const y = J / SS;
        let j0 = y | 0; if (j0 > ny - 2) j0 = ny - 2;
        const ty = y - j0, ty0 = 1 - ty, row = j0 * nx;
        for (let I = 0; I < sx; I++) {
            const x = I / SS;
            let i0 = x | 0; if (i0 > nx - 2) i0 = nx - 2;
            const tx = x - i0, tx0 = 1 - tx, a = row + i0;
            const uu = tx0 * (ty0 * u[a] + ty * u[a + nx]) + tx * (ty0 * u[a + 1] + ty * u[a + nx + 1]);
            const vv = tx0 * (ty0 * v[a] + ty * v[a + nx]) + tx * (ty0 * v[a + 1] + ty * v[a + nx + 1]);

            let sI = I - uu * dt0x;
            let sJ = J - vv * dt0y;
            if (sI < 0) sI = 0; else if (sI > sx - 1) sI = sx - 1;
            if (sJ < 0) sJ = 0; else if (sJ > sy - 1) sJ = sy - 1;
            const bi = sI | 0, bj = sJ | 0;
            const fx = sI - bi, fx0 = 1 - fx, fy = sJ - bj, fy0 = 1 - fy;
            const dI = bi < sx - 1 ? 1 : 0, dJ = bj < sy - 1 ? sx : 0, p = bj * sx + bi;
            const adv =
                fx0 * (fy0 * streak0[p] + fy * streak0[p + dJ]) +
                fx * (fy0 * streak0[p + dI] + fy * streak0[p + dI + dJ]);
            // Image-Based Flow Visualization (van Wijk 2002): blend a little
            // fresh noise into every pixel each frame. The advection then draws
            // that noise into long silky filaments, while the constant refresh
            // avoids the moiré banding that pure re-advection produces in uniform
            // flow.
            streak[J * sx + I] = adv * (1 - INJECT) + Math.random() * INJECT;
        }
    }

    // Crisp fresh threads right at the inlet so filaments are born sharp
    for (let J = 0; J < sy; J++) {
        const base = J * sx;
        for (let I = 0; I < SS * 2; I++) streak[base + I] = Math.random();
    }
}

function renderVelocityHiRes(ref) {
    ensureHiRes();
    const data = hiImage.data;
    const nx = config.nx, ny = config.ny, s = fluid.s, u = fluid.u, v = fluid.v;
    const inv = 1 / ref;

    for (let J = 0; J < sy; J++) {
        const y = J / SS;
        let j0 = y | 0; if (j0 > ny - 2) j0 = ny - 2;
        const ty = y - j0, ty0 = 1 - ty, row = j0 * nx;
        for (let I = 0; I < sx; I++) {
            const x = I / SS;
            let i0 = x | 0; if (i0 > nx - 2) i0 = nx - 2;
            const tx = x - i0, tx0 = 1 - tx, a = row + i0;
            const p4 = (J * sx + I) * 4;

            // Solid body: only when the whole sampling cell is obstacle, so the
            // white outline drawn later gets a crisp dark backing.
            if (s[a] === 1 && s[a + 1] === 1 && s[a + nx] === 1 && s[a + nx + 1] === 1) {
                data[p4] = OBSTACLE_RGB[0]; data[p4 + 1] = OBSTACLE_RGB[1];
                data[p4 + 2] = OBSTACLE_RGB[2]; data[p4 + 3] = 255;
                continue;
            }
            const uu = tx0 * (ty0 * u[a] + ty * u[a + nx]) + tx * (ty0 * u[a + 1] + ty * u[a + nx + 1]);
            const vv = tx0 * (ty0 * v[a] + ty * v[a + nx]) + tx * (ty0 * v[a + 1] + ty * v[a + nx + 1]);
            const mag = Math.sqrt(uu * uu + vv * vv);
            let t = mag * inv; if (t > 1) t = 1;
            const c = turboColor(t);
            const shade = 0.45 + 0.95 * streak[J * sx + I];
            data[p4] = c[0] * shade;
            data[p4 + 1] = c[1] * shade;
            data[p4 + 2] = c[2] * shade;
            data[p4 + 3] = 255;
        }
    }
    hiCtx.putImageData(hiImage, 0, 0);
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

/* ---------------------------------------------------------------------------
 * Streamlines
 *
 * Lines that follow the flow, integrated through the velocity field from a rake
 * of seed points. Unlike a grid of little arrows, they show the *story* of the
 * flow: where it splits at the leading-edge stagnation point, how it speeds up
 * over the top (lines crowd together), and where it separates and rolls into
 * vortices in the wake. Each segment is coloured by local speed with the same
 * Turbo map as the flow view, and small chevrons mark the direction.
 * ------------------------------------------------------------------------- */

function drawArrowHead(px, py, dx, dy, color, size) {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;   // travel direction
    const wx = -uy, wy = ux;              // perpendicular
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px + ux * size, py + uy * size);
    ctx.lineTo(px - ux * size * 0.4 + wx * size * 0.7, py - uy * size * 0.4 + wy * size * 0.7);
    ctx.lineTo(px - ux * size * 0.4 - wx * size * 0.7, py - uy * size * 0.4 - wy * size * 0.7);
    ctx.closePath();
    ctx.fill();
}

// Integrate and draw one streamline from (x, y) in grid coords, RK2 with a
// fixed arc-length step so spacing stays even regardless of local speed.
function traceStreamline(x, y, h, maxSteps, ref, cs) {
    const nx = config.nx, ny = config.ny;
    let stepsSinceArrow = (Math.random() * 12) | 0; // stagger arrows between lines

    for (let n = 0; n < maxSteps; n++) {
        const v1 = sampleVelocity(x, y);
        const s1 = Math.hypot(v1.u, v1.v);
        if (s1 < 1e-4) break;                       // hit stagnation
        const mx = x + (v1.u / s1) * h * 0.5;
        const my = y + (v1.v / s1) * h * 0.5;
        if (mx < 0.6 || mx > nx - 1.6 || my < 0.6 || my > ny - 1.6) break;

        const v2 = sampleVelocity(mx, my);
        const s2 = Math.hypot(v2.u, v2.v);
        if (s2 < 1e-4) break;
        const dx = (v2.u / s2) * h;
        const dy = (v2.v / s2) * h;

        const x2 = x + dx;
        const y2 = y + dy;
        if (x2 < 0.6 || x2 > nx - 1.6 || y2 < 0.6 || y2 > ny - 1.6) break;
        if (fluid.s[fluid.IX(Math.round(x2), Math.round(y2))] === 1) break;

        const t = Math.min(1, s2 / ref);
        const c = turboColor(t);
        const col = `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(x * cs, y * cs);
        ctx.lineTo(x2 * cs, y2 * cs);
        ctx.stroke();

        if (++stepsSinceArrow >= 16) {
            stepsSinceArrow = 0;
            drawArrowHead(x2 * cs, y2 * cs, dx, dy, col, 4.5);
        }

        x = x2; y = y2;
    }
}

function drawStreamlines(cs) {
    const nx = config.nx, ny = config.ny;
    const ref = contourReference();

    // Dim Turbo heatmap backdrop: keeps the fast/slow context (red suction
    // peak, blue wake) without competing with the lines drawn on top.
    renderVelocityHiRes(ref);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.30;
    ctx.drawImage(hiCanvas, 0, 0, nx * cs, ny * cs);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(6, 8, 12, 0.32)';
    ctx.fillRect(0, 0, nx * cs, ny * cs);

    const h = 0.6;                              // step length in cells
    const maxSteps = (nx * 2.5) | 0;
    ctx.lineWidth = 1.35;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 2;

    // Primary rake at the inlet: shows how the whole stream parts around the body
    const inletSeeds = Math.min(48, Math.max(20, (ny / 1.5) | 0));
    for (let s = 0; s < inletSeeds; s++) {
        traceStreamline(1.6, ny * (s + 0.5) / inletSeeds, h, maxSteps, ref, cs);
    }
    // Secondary sparse rake downstream so recirculation in the wake gets traced
    // (upstream lines don't always penetrate a separation bubble).
    for (let s = 0; s < 10; s++) {
        traceStreamline(nx * 0.62, ny * (s + 0.5) / 10, h, (nx * 1.2) | 0, ref, cs);
    }

    ctx.shadowBlur = 0;
}

function drawContourLegend(maxV) {
    const legW = 20;
    const legH = 200;
    const legX = 20;
    const legY = 30;

    const grad = ctx.createLinearGradient(0, legY + legH, 0, legY);
    for (let s = 0; s <= 10; s++) {
        const c = turboColor(s / 10);
        grad.addColorStop(s / 10, `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`);
    }

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

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(airfoilBoundary[0].x * cs, airfoilBoundary[0].y * cs);
    for (let i = 1; i < airfoilBoundary.length; i++) {
        ctx.lineTo(airfoilBoundary[i].x * cs, airfoilBoundary[i].y * cs);
    }
    ctx.closePath();

    // Near-black silhouette so the object reads as a solid body against the
    // bright flow, with a crisp white outline that pops in every colour map.
    ctx.fillStyle = '#0b0d12';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();
}

// Straight arrow with a filled head, using the streamline arrowhead helper.
function drawArrow(x0, y0, x1, y1, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const dx = x1 - x0, dy = y1 - y0;
    if (dx * dx + dy * dy > 9) drawArrowHead(x1, y1, dx, dy, color, Math.max(5, width * 2.2));
}

// Force diagram anchored on the body, echoing the reel: a yellow move-handle at
// the pivot, an orange drag arrow (streamwise), a green lift arrow (normal), and
// the magenta resultant. Lengths track the live force readout, so you watch the
// resultant swing forward and collapse as the wing approaches stall.
function drawForceVectors(cs) {
    if (config.objectType !== 'airfoil' || airfoilBoundary.length === 0) return;

    const cx = config.nx * config.objXFrac * cs;
    const cy = config.ny * config.objYFrac * cs;
    const k = 80;                                   // px per unit of force
    const maxLen = config.nx * 0.22 * cs * 1.5;     // clamp to ~1.5 chords
    const clampLen = (v) => Math.max(-maxLen, Math.min(maxLen, v));
    const up = clampLen(forces.lift * k);           // lift → upward (−y)
    const right = clampLen(forces.drag * k);        // drag → downstream (+x)

    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 3;

    drawArrow(cx, cy, cx + right, cy, '#ff9a3c', 2.5);          // drag (orange)
    drawArrow(cx, cy, cx, cy - up, '#39e56b', 2.5);            // lift (green)
    drawArrow(cx, cy, cx + right, cy - up, '#ff3ea5', 3);      // resultant (magenta)

    ctx.shadowBlur = 0;
    const hs = 6;                                              // yellow handle
    ctx.strokeStyle = '#ffd23c';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - hs, cy - hs, hs * 2, hs * 2);
    ctx.beginPath();
    ctx.moveTo(cx - hs, cy); ctx.lineTo(cx + hs, cy);
    ctx.moveTo(cx, cy - hs); ctx.lineTo(cx, cy + hs);
    ctx.stroke();
    ctx.restore();
}

// Representative lift-coefficient model: linear thin-airfoil slope tapered by
// the same separation model the solver uses, so the mini plot shows the stall.
function clModel(aoaDeg) {
    const linear = 0.10 * aoaDeg;
    return linear * (1 - 0.72 * separationFraction(aoaDeg));
}

function drawMiniLiftCurve() {
    const w = ui.miniLift.width, h = ui.miniLift.height;
    miniCtx.clearRect(0, 0, w, h);

    if (config.objectType !== 'airfoil') {
        miniCtx.fillStyle = 'rgba(200,208,220,0.6)';
        miniCtx.font = '10px JetBrains Mono, monospace';
        miniCtx.textAlign = 'center';
        miniCtx.fillText('airfoil only', w / 2, h / 2);
        return;
    }

    const x0 = 6, x1 = w - 6, y0 = 8, y1 = h - 13;
    const aoaMin = -20, aoaMax = 20, clMax = 1.6;
    const X = a => x0 + (a - aoaMin) / (aoaMax - aoaMin) * (x1 - x0);
    const Y = cl => (y0 + y1) / 2 - cl / clMax * ((y1 - y0) / 2);

    // Zero axes
    miniCtx.strokeStyle = 'rgba(130,140,155,0.35)';
    miniCtx.lineWidth = 1;
    miniCtx.beginPath();
    miniCtx.moveTo(x0, Y(0)); miniCtx.lineTo(x1, Y(0));
    miniCtx.moveTo(X(0), y0); miniCtx.lineTo(X(0), y1);
    miniCtx.stroke();

    // Cl curve
    miniCtx.strokeStyle = '#39e56b';
    miniCtx.lineWidth = 1.8;
    miniCtx.beginPath();
    for (let a = aoaMin; a <= aoaMax; a += 0.5) {
        const px = X(a), py = Y(clModel(a));
        if (a === aoaMin) miniCtx.moveTo(px, py); else miniCtx.lineTo(px, py);
    }
    miniCtx.stroke();

    // Live operating point
    const cx = X(config.aoa), cy = Y(clModel(config.aoa));
    miniCtx.fillStyle = '#fff';
    miniCtx.beginPath(); miniCtx.arc(cx, cy, 3, 0, Math.PI * 2); miniCtx.fill();
    miniCtx.strokeStyle = '#ff3ea5';
    miniCtx.lineWidth = 1.4;
    miniCtx.beginPath(); miniCtx.arc(cx, cy, 5.5, 0, Math.PI * 2); miniCtx.stroke();

    // Axis labels
    miniCtx.fillStyle = 'rgba(200,208,220,0.7)';
    miniCtx.font = '9px JetBrains Mono, monospace';
    miniCtx.textBaseline = 'alphabetic';
    miniCtx.textAlign = 'left'; miniCtx.fillText('-20°', x0, h - 3);
    miniCtx.textAlign = 'right'; miniCtx.fillText('+20°', x1, h - 3);
    miniCtx.textAlign = 'center'; miniCtx.fillText(`α ${config.aoa}°`, X(0), h - 3);
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cs = config.cellSize;

    if (config.vizMode === 'velocity') {
        drawStreamlines(cs);
    } else if (config.vizMode === 'particles') {
        drawParticles(cs);
    } else if (config.vizMode === 'velocity-contour') {
        // Silky high-resolution flow view (the reel look)
        const ref = contourReference();
        renderVelocityHiRes(ref);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(hiCanvas, 0, 0, config.nx * cs, config.ny * cs);
        drawContourLegend(ref);
    } else {
        ensureFieldBuffer();
        const data = fieldImage.data;

        if (config.vizMode === 'dye') {
            renderDyeField(data);
        } else if (config.vizMode === 'pressure') {
            renderPressureField(data);
        }

        fieldCtx.putImageData(fieldImage, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fieldCanvas, 0, 0, config.nx * cs, config.ny * cs);
    }

    drawObjectOutline(cs);
    drawForceVectors(cs);
    drawMiniLiftCurve();
}

/* ---------------------------------------------------------------------------
 * Angle-of-attack sweep + lift curve
 *
 * Steps the airfoil through a range of angles, letting the flow settle and
 * averaging the force readout at each, then plots lift and drag vs angle so
 * the stall (peak lift before it drops) is visible.
 * ------------------------------------------------------------------------- */

let sweeping = false;
let sweepResults = [];
let chartGeom = null; // { plotL, plotR } for hover mapping

const SWEEP_MIN = -20, SWEEP_MAX = 20, SWEEP_STEP = 2;
const SWEEP_SETTLE = 90; // steps to let the flow adapt at each angle
const SWEEP_AVG = 40;    // steps averaged for the measurement

const CHART = {
    lift: '#3987e5',   // validated categorical slot (see dataviz palette)
    drag: '#d95926',
    grid: '#2c2c2a',
    axis: '#4a4a47',
    zero: '#6a6a66',
    ink: '#f0f0f5',
    muted: '#898781',
    surface: '#101116'
};

function nextFrame() {
    return new Promise(r => requestAnimationFrame(() => r()));
}

async function runSweep() {
    if (sweeping || config.objectType !== 'airfoil') return;

    sweeping = true;
    ui.btnSweep.disabled = true;
    ui.chartOverlay.classList.add('hidden');
    ui.sweepStatus.classList.remove('hidden');

    const prevAoa = config.aoa;
    const prevConfinement = fluid.confinement;
    // A polar is a quasi-steady measurement: damp the shedding so the averaged
    // forces are clean (the stall itself comes from the separation model, not
    // from the turbulent unsteadiness).
    fluid.confinement = 1.5;
    const uSpeed = Math.max(0.2, (config.speed / 100) * 2.0); // guarantee some flow
    const results = [];

    for (let a = SWEEP_MIN; a <= SWEEP_MAX; a += SWEEP_STEP) {
        config.aoa = a;
        ui.aoaSlider.value = a;
        ui.aoaVal.textContent = `${a}°`;
        updateObstacle();
        ui.sweepStatus.textContent = `Sweeping…  α = ${a > 0 ? '+' : ''}${a}°`;

        for (let k = 0; k < SWEEP_SETTLE; k++) fluid.step(config.dt, config.visc, 0, uSpeed);

        let liftSum = 0, dragSum = 0;
        for (let k = 0; k < SWEEP_AVG; k++) {
            fluid.step(config.dt, config.visc, 0, uSpeed);
            const f = aeroForces();
            liftSum += f.lift;
            dragSum += f.drag;
        }
        results.push({ aoa: a, lift: liftSum / SWEEP_AVG, drag: dragSum / SWEEP_AVG });

        await nextFrame(); // paint progress + current flow between angles
    }

    // Restore the pre-sweep angle and live turbulence level
    fluid.confinement = prevConfinement;
    config.aoa = prevAoa;
    ui.aoaSlider.value = prevAoa;
    ui.aoaVal.textContent = `${prevAoa}°`;
    updateObstacle();

    sweepResults = results;
    sweeping = false;
    ui.btnSweep.disabled = false;
    ui.sweepStatus.classList.add('hidden');

    ui.chartOverlay.classList.remove('hidden');
    renderLiftCurve(-1);
    syncURL();
}

function onChartHover(e) {
    if (!chartGeom || sweepResults.length === 0) return;
    const rect = ui.chartCanvas.getBoundingClientRect();
    const logicalX = (e.clientX - rect.left) * (360 / rect.width);
    const frac = (logicalX - chartGeom.plotL) / (chartGeom.plotR - chartGeom.plotL);
    const aoa = SWEEP_MIN + frac * (SWEEP_MAX - SWEEP_MIN);
    let idx = Math.round((aoa - SWEEP_MIN) / SWEEP_STEP);
    idx = Math.max(0, Math.min(sweepResults.length - 1, idx));
    renderLiftCurve(idx);
}

function renderLiftCurve(hoverIndex) {
    const cv = ui.chartCanvas;
    const c = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = 360, H = 240;
    cv.width = W * dpr;
    cv.height = H * dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    const mL = 40, mR = 46, mT = 26, mB = 30;
    const plotL = mL, plotR = W - mR, plotT = mT, plotB = H - mB;
    chartGeom = { plotL, plotR };

    // Symmetric Y scale so the zero line sits where lift crosses it
    let yMax = 0.5;
    for (const r of sweepResults) yMax = Math.max(yMax, Math.abs(r.lift), Math.abs(r.drag));
    yMax *= 1.12;

    const xOf = (aoa) => plotL + ((aoa - SWEEP_MIN) / (SWEEP_MAX - SWEEP_MIN)) * (plotR - plotL);
    const yOf = (val) => plotT + (1 - (val + yMax) / (2 * yMax)) * (plotB - plotT);

    c.font = '10px JetBrains Mono, monospace';
    c.textBaseline = 'middle';

    // Gridlines + Y tick labels
    c.strokeStyle = CHART.grid;
    c.lineWidth = 1;
    c.fillStyle = CHART.muted;
    c.textAlign = 'right';
    for (let t = -1; t <= 1; t += 0.5) {
        const val = t * yMax;
        const y = yOf(val);
        c.beginPath();
        c.moveTo(plotL, y);
        c.lineTo(plotR, y);
        c.stroke();
        c.fillText(val.toFixed(1), plotL - 6, y);
    }

    // X ticks + labels
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (let a = SWEEP_MIN; a <= SWEEP_MAX; a += 10) {
        const x = xOf(a);
        c.strokeStyle = CHART.grid;
        c.beginPath();
        c.moveTo(x, plotT);
        c.lineTo(x, plotB);
        c.stroke();
        c.fillStyle = CHART.muted;
        c.fillText(`${a}`, x, plotB + 6);
    }
    c.fillText('Angle of attack (°)', (plotL + plotR) / 2, H - 11);

    // Emphasized zero line
    c.strokeStyle = CHART.zero;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(plotL, yOf(0));
    c.lineTo(plotR, yOf(0));
    c.stroke();

    // Y axis title, clear above the top gridline
    c.fillStyle = CHART.muted;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('Force (arb.)', plotL - 34, plotT - 16);

    if (sweepResults.length === 0) return;

    const drawSeries = (key, color) => {
        c.strokeStyle = color;
        c.lineWidth = 2;
        c.lineJoin = 'round';
        c.beginPath();
        sweepResults.forEach((r, i) => {
            const x = xOf(r.aoa), y = yOf(r[key]);
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.stroke();

        c.fillStyle = color;
        for (const r of sweepResults) {
            c.beginPath();
            c.arc(xOf(r.aoa), yOf(r[key]), 2.2, 0, Math.PI * 2);
            c.fill();
        }

        // Direct label at the series end
        const last = sweepResults[sweepResults.length - 1];
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText(key === 'lift' ? 'Lift' : 'Drag', plotR + 4, yOf(last[key]));
    };

    drawSeries('drag', CHART.drag);
    drawSeries('lift', CHART.lift);

    // Mark the stall (peak lift), if it is an interior maximum
    let peak = 0;
    for (let i = 1; i < sweepResults.length; i++) {
        if (sweepResults[i].lift > sweepResults[peak].lift) peak = i;
    }
    const stall = sweepResults[peak];
    const isInterior = peak > 0 && peak < sweepResults.length - 1;
    if (isInterior) {
        const px = xOf(stall.aoa), py = yOf(stall.lift);
        c.strokeStyle = CHART.ink;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(px, py, 5, 0, Math.PI * 2);
        c.stroke();
        ui.chartNote.textContent = `Stall ≈ ${stall.aoa > 0 ? '+' : ''}${stall.aoa}°`;
    } else {
        ui.chartNote.textContent = 'No clear stall in ±20°';
    }

    // Hover crosshair + tooltip
    if (hoverIndex >= 0 && hoverIndex < sweepResults.length) {
        const r = sweepResults[hoverIndex];
        const hx = xOf(r.aoa);
        c.strokeStyle = 'rgba(240,240,245,0.35)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(hx, plotT);
        c.lineTo(hx, plotB);
        c.stroke();

        c.fillStyle = CHART.lift;
        c.beginPath();
        c.arc(hx, yOf(r.lift), 3.4, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = CHART.drag;
        c.beginPath();
        c.arc(hx, yOf(r.drag), 3.4, 0, Math.PI * 2);
        c.fill();

        const lines = [
            `α ${r.aoa > 0 ? '+' : ''}${r.aoa}°`,
            `Lift ${r.lift.toFixed(1)}`,
            `Drag ${r.drag.toFixed(1)}`
        ];
        const boxW = 78, boxH = 46;
        let bx = hx + 8;
        if (bx + boxW > plotR) bx = hx - 8 - boxW;
        const by = plotT + 4;
        c.fillStyle = 'rgba(10,10,12,0.9)';
        c.strokeStyle = CHART.axis;
        c.lineWidth = 1;
        c.fillRect(bx, by, boxW, boxH);
        c.strokeRect(bx, by, boxW, boxH);
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillStyle = CHART.ink;
        lines.forEach((ln, i) => c.fillText(ln, bx + 7, by + 7 + i * 13));
    }
}

// Start app
window.onload = init;
