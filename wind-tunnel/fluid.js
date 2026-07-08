/**
 * Eulerian Fluid Simulator on a staggered grid.
 * Real-time, stable fluids approach.
 */
class FluidGrid {
    /**
     * @param {number} nx - number of cells in X
     * @param {number} ny - number of cells in Y
     */
    constructor(nx, ny) {
        this.nx = nx;
        this.ny = ny;
        this.numCells = this.nx * this.ny;

        // Current state
        this.u = new Float32Array(this.numCells); // velocity X
        this.v = new Float32Array(this.numCells); // velocity Y
        this.p = new Float32Array(this.numCells); // pressure
        this.d = new Float32Array(this.numCells); // dye/smoke density

        // Previous state (for advection/diffusion)
        this.u0 = new Float32Array(this.numCells);
        this.v0 = new Float32Array(this.numCells);
        this.d0 = new Float32Array(this.numCells);

        // Scratch buffer for the MacCormack dye advection
        this.mcc1 = new Float32Array(this.numCells);

        // Obstacle mask and velocities
        this.s = new Float32Array(this.numCells);
        this.s.fill(0); // All fluid initially
        this.obsU = new Float32Array(this.numCells);
        this.obsV = new Float32Array(this.numCells);

        // Vorticity (curl) buffer, used by vorticity confinement
        this.curl = new Float32Array(this.numCells);

        this.iter = 10; // Solver iterations for pressure (Poisson)

        // Vorticity confinement strength. Semi-Lagrangian advection is very
        // diffusive and smears out the vortices that make wakes interesting;
        // this re-injects the small-scale swirl that would otherwise be lost,
        // producing shear-layer roll-up and von Kármán shedding.
        this.confinement = 6.0;

        // Phase for the tiny inlet perturbation that breaks the perfect
        // symmetry, so shedding actually starts instead of sitting in an
        // unstable steady state forever.
        this.perturbPhase = Math.random() * Math.PI * 2;
    }

    IX(x, y) {
        // Clamp to edges
        x = Math.max(0, Math.min(x, this.nx - 1));
        y = Math.max(0, Math.min(y, this.ny - 1));
        return (x) + (y) * this.nx;
    }

    // Copy the overlapping region of another grid's fields (used to keep the
    // flow alive when the grid is rebuilt on window resize).
    copyFieldsFrom(other) {
        const nxMin = Math.min(this.nx, other.nx);
        const nyMin = Math.min(this.ny, other.ny);
        for (let j = 0; j < nyMin; j++) {
            for (let i = 0; i < nxMin; i++) {
                const a = this.IX(i, j);
                const b = other.IX(i, j);
                this.u[a] = other.u[b];
                this.v[a] = other.v[b];
                this.p[a] = other.p[b];
                this.d[a] = other.d[b];
            }
        }
    }

    clearObstacles() {
        this.s.fill(0);
        this.obsU.fill(0);
        this.obsV.fill(0);
    }

    setObstacle(x, y) {
        if (x >= 0 && x < this.nx && y >= 0 && y < this.ny) {
            this.s[this.IX(x, y)] = 1;
        }
    }

    setObstacleVelocity(x, y, u, v) {
        if (x >= 0 && x < this.nx && y >= 0 && y < this.ny) {
            let idx = this.IX(x, y);
            this.obsU[idx] = u;
            this.obsV[idx] = v;
        }
    }

    addVelocity(x, y, amountX, amountY) {
        let index = this.IX(x, y);
        this.u[index] += amountX;
        this.v[index] += amountY;
    }

    addDye(x, y, amount) {
        let index = this.IX(x, y);
        this.d[index] += amount;
    }

    // Step the simulation
    step(dt, visc, diff, windSpeed) {
        // Weak global drive toward the freestream. Kept gentle: a strong pull
        // (the old 0.99/0.01) relaxes the whole field back to uniform flow
        // every step and erases the wake before any vortex can form.
        const relax = 0.003;
        for (let i = 0; i < this.numCells; i++) {
            if (this.s[i] === 0) {
                this.u[i] = this.u[i] * (1 - relax) + windSpeed * relax;
            }
        }

        // Swap arrays
        let tmp = this.u0; this.u0 = this.u; this.u = tmp;
        tmp = this.v0; this.v0 = this.v; this.v = tmp;
        tmp = this.d0; this.d0 = this.d; this.d = tmp;

        // Advect
        this.advect(1, this.u, this.u0, this.u0, this.v0, dt);
        this.advect(2, this.v, this.v0, this.u0, this.v0, dt);

        // Diffuse (viscosity) - ignored for performance unless high viscosity requested
        if (visc > 0) {
            this.u0.set(this.u);
            this.v0.set(this.v);
            this.diffuse(1, this.u, this.u0, visc, dt);
            this.diffuse(2, this.v, this.v0, visc, dt);
        }

        // Re-inject the small-scale vorticity lost to numerical diffusion
        this.vorticityConfinement(dt);

        // Project (make divergence free & calculate pressure)
        this.project(this.u, this.v, this.p, this.u0); // u0 is used as div temp array

        // Keep velocities bounded so confinement can't make the sim blow up
        this.clampVelocity(6.0);

        // Move dye with a less diffusive scheme so the smoke actually rolls up
        // into visible vortices instead of smearing into a uniform haze
        this.advectDyeMacCormack(this.d0, this.u, this.v, dt);

        // Continuous input stream
        this.injectWind(windSpeed, dt);
    }

    // MacCormack advection for the dye: a forward and a backward semi-Lagrangian
    // pass estimate the scheme's own error and cancel most of it, cutting the
    // numerical diffusion that would otherwise blur the smoke. The result is
    // clamped to the source interpolation stencil so it can't overshoot.
    advectDyeMacCormack(d0, u, v, dt) {
        this.advect(0, this.d, d0, u, v, dt);        // forward: d = A(d0)
        this.advect(0, this.mcc1, this.d, u, v, -dt); // backward: mcc1 = A⁻¹(d)

        const nx = this.nx, ny = this.ny, s = this.s, d = this.d, mcc1 = this.mcc1;
        const dt0x = dt * (nx - 2);
        const dt0y = dt * (ny - 2);

        for (let j = 1; j < ny - 1; j++) {
            let idx = j * nx + 1;
            for (let i = 1; i < nx - 1; i++, idx++) {
                if (s[idx] === 1) continue;

                // Re-trace to find the source stencil for clamping
                let x = i - dt0x * u[idx];
                let y = j - dt0y * v[idx];
                if (x < 0.5) x = 0.5; else if (x > nx - 1.5) x = nx - 1.5;
                if (y < 0.5) y = 0.5; else if (y > ny - 1.5) y = ny - 1.5;
                const i0 = x | 0, j0 = y | 0;
                const p00 = j0 * nx + i0;
                const c00 = d0[p00], c10 = d0[p00 + 1], c01 = d0[p00 + nx], c11 = d0[p00 + nx + 1];
                let lo = c00, hi = c00;
                if (c10 < lo) lo = c10; else if (c10 > hi) hi = c10;
                if (c01 < lo) lo = c01; else if (c01 > hi) hi = c01;
                if (c11 < lo) lo = c11; else if (c11 > hi) hi = c11;

                let corrected = d[idx] + 0.5 * (d0[idx] - mcc1[idx]);
                if (corrected < lo) corrected = lo; else if (corrected > hi) corrected = hi;
                d[idx] = corrected;
            }
        }
        this.setBnd(0, this.d);
    }

    // z-component of the curl (vorticity) at each interior fluid cell
    computeCurl() {
        const nx = this.nx, ny = this.ny, s = this.s, u = this.u, v = this.v, curl = this.curl;
        for (let j = 1; j < ny - 1; j++) {
            let idx = j * nx + 1;
            for (let i = 1; i < nx - 1; i++, idx++) {
                if (s[idx] === 1) { curl[idx] = 0; continue; }
                const dvdx = (v[idx + 1] - v[idx - 1]) * 0.5;
                const dudy = (u[idx + nx] - u[idx - nx]) * 0.5;
                curl[idx] = dvdx - dudy;
            }
        }
    }

    // Vorticity confinement (Fedkiw et al. 2001): add a body force that points
    // along N × ω, where N is the unit gradient of |ω|. This drives velocity to
    // curl around vorticity maxima, sharpening and sustaining vortices.
    vorticityConfinement(dt) {
        if (this.confinement <= 0) return;
        this.computeCurl();

        const eps = this.confinement;
        const nx = this.nx, ny = this.ny, s = this.s, curl = this.curl;
        for (let j = 2; j < ny - 2; j++) {
            let idx = j * nx + 2;
            for (let i = 2; i < nx - 2; i++, idx++) {
                if (s[idx] === 1) continue;

                const gx = (Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1])) * 0.5;
                const gy = (Math.abs(curl[idx + nx]) - Math.abs(curl[idx - nx])) * 0.5;
                const len = Math.sqrt(gx * gx + gy * gy) + 1e-5;
                const nrmx = gx / len;
                const nrmy = gy / len;
                const w = curl[idx];

                // f = eps * (N × ω ẑ) = eps * (Ny*w, -Nx*w)
                this.u[idx] += eps * dt * (nrmy * w);
                this.v[idx] += eps * dt * (-nrmx * w);
            }
        }
    }

    clampVelocity(cap) {
        for (let i = 0; i < this.numCells; i++) {
            if (this.u[i] > cap) this.u[i] = cap; else if (this.u[i] < -cap) this.u[i] = -cap;
            if (this.v[i] > cap) this.v[i] = cap; else if (this.v[i] < -cap) this.v[i] = -cap;
        }
    }

    injectWind(windSpeed, dt) {
        // A small time-varying + random cross-flow at the inlet. Without any
        // asymmetry a symmetric obstacle sits in an unstable steady state and
        // never sheds; this nudge lets the natural instability grow into a
        // proper von Kármán street.
        this.perturbPhase += dt * 3.0;
        const wobble = Math.sin(this.perturbPhase) * windSpeed * 0.025;

        const tunnelInletWidth = Math.floor(this.ny);
        for (let j = 0; j < tunnelInletWidth; j++) {
            // Inject velocity in first few columns
            for (let i = 0; i < 4; i++) {
                const idx = this.IX(i, j);
                if (this.s[idx] === 0) {
                    this.u[idx] = windSpeed;
                    this.v[idx] = wobble + (Math.random() - 0.5) * windSpeed * 0.02;
                }
            }

            // Inject dye at the very left edge
            const idxLeft = this.IX(0, j);
            // Finer, more frequent smoke lines (every 4 cells, 1 cell wide)
            if (j % 5 === 0 && j > 2 && j < this.ny - 2) {
                this.d[idxLeft] = 1.0;
            } else {
                this.d[idxLeft] *= 0.95; // Fade non-dye faster
            }
        }

        // Outlet dye fading
        for (let j = 0; j < this.ny; j++) {
            this.d[this.IX(this.nx - 1, j)] = 0;
            this.d[this.IX(this.nx - 2, j)] *= 0.8;
        }
    }

    setBnd(b, x) {
        // Top and bottom walls
        for (let i = 1; i < this.nx - 1; i++) {
            x[this.IX(i, 0)] = b === 2 ? -x[this.IX(i, 1)] : x[this.IX(i, 1)];
            x[this.IX(i, this.ny - 1)] = b === 2 ? -x[this.IX(i, this.ny - 2)] : x[this.IX(i, this.ny - 2)];
        }
        // Left (Inlet) and Right (Outlet) open boundaries
        for (let j = 0; j < this.ny; j++) {
            // Outlet (Right): zero gradient
            x[this.IX(this.nx - 1, j)] = x[this.IX(this.nx - 2, j)];

            // Inlet (Left): for pressure/divergence, zero gradient. For u/v/d, leave them as forced by injectWind.
            if (b === 0) {
                x[this.IX(0, j)] = x[this.IX(1, j)];
            }
        }

        // Corners
        x[this.IX(0, 0)] = 0.5 * (x[this.IX(1, 0)] + x[this.IX(0, 1)]);
        x[this.IX(0, this.ny - 1)] = 0.5 * (x[this.IX(1, this.ny - 1)] + x[this.IX(0, this.ny - 2)]);
        x[this.IX(this.nx - 1, 0)] = 0.5 * (x[this.IX(this.nx - 2, 0)] + x[this.IX(this.nx - 1, 1)]);
        x[this.IX(this.nx - 1, this.ny - 1)] = 0.5 * (x[this.IX(this.nx - 2, this.ny - 1)] + x[this.IX(this.nx - 1, this.ny - 2)]);

        // Obstacles (Airfoil or Cylinder)
        for (let j = 1; j < this.ny - 1; j++) {
            for (let i = 1; i < this.nx - 1; i++) {
                let idx = this.IX(i, j);
                if (this.s[idx] === 1) {
                    if (b === 1) x[idx] = this.obsU[idx]; // x velocity inside
                    else if (b === 2) x[idx] = this.obsV[idx]; // y velocity inside
                    else x[idx] = 0; // density/pressure zero inside
                }
            }
        }
    }

    linSolve(b, x, x0, a, c) {
        // Interior neighbours are always in range, so index arithmetic replaces
        // the clamped IX() in this hot loop (the Poisson solve runs it iter times).
        const cRecip = 1.0 / c;
        const nx = this.nx, ny = this.ny, s = this.s;
        for (let k = 0; k < this.iter; k++) {
            for (let j = 1; j < ny - 1; j++) {
                let idx = j * nx + 1;
                for (let i = 1; i < nx - 1; i++, idx++) {
                    if (s[idx] === 0) {
                        x[idx] = (x0[idx] + a * (x[idx + 1] + x[idx - 1] + x[idx + nx] + x[idx - nx])) * cRecip;
                    } else {
                        x[idx] = 0;
                    }
                }
            }
            this.setBnd(b, x);
        }
    }

    diffuse(b, x, x0, diff, dt) {
        let a = dt * diff * (this.nx - 2) * (this.ny - 2);
        this.linSolve(b, x, x0, a, 1 + 4 * a);
    }

    advect(b, d, d0, u, v, dt) {
        const nx = this.nx, ny = this.ny, s = this.s;
        const dt0x = dt * (nx - 2);
        const dt0y = dt * (ny - 2);

        for (let j = 1; j < ny - 1; j++) {
            let idx = j * nx + 1;
            for (let i = 1; i < nx - 1; i++, idx++) {
                if (s[idx] === 1) continue; // Skip obstacles

                let x = i - dt0x * u[idx];
                let y = j - dt0y * v[idx];

                // Clamp so the whole interpolation stencil stays in range
                if (x < 0.5) x = 0.5; else if (x > nx - 1.5) x = nx - 1.5;
                if (y < 0.5) y = 0.5; else if (y > ny - 1.5) y = ny - 1.5;

                const i0 = x | 0, j0 = y | 0;
                const s1 = x - i0, s0 = 1.0 - s1;
                const t1 = y - j0, t0 = 1.0 - t1;

                const p00 = j0 * nx + i0;
                const p10 = p00 + 1, p01 = p00 + nx, p11 = p00 + nx + 1;

                // Bilinear interpolation
                d[idx] = s0 * (t0 * d0[p00] + t1 * d0[p01]) +
                    s1 * (t0 * d0[p10] + t1 * d0[p11]);
            }
        }
        this.setBnd(b, d);
    }

    project(u, v, p, div) {
        const hx = 1.0 / this.nx;
        const hy = 1.0 / this.ny;
        const nx = this.nx, ny = this.ny, s = this.s;

        for (let j = 1; j < ny - 1; j++) {
            let idx = j * nx + 1;
            for (let i = 1; i < nx - 1; i++, idx++) {
                if (s[idx] === 0) {
                    div[idx] = -0.5 * (u[idx + 1] - u[idx - 1]) * hx
                        - 0.5 * (v[idx + nx] - v[idx - nx]) * hy;
                    p[idx] = 0;
                }
            }
        }

        this.setBnd(0, div);
        this.setBnd(0, p);

        // Solve Poisson equation for pressure
        this.linSolve(0, p, div, 1, 4);

        for (let j = 1; j < ny - 1; j++) {
            let idx = j * nx + 1;
            for (let i = 1; i < nx - 1; i++, idx++) {
                if (s[idx] === 0) {
                    const pc = p[idx];
                    let p1 = s[idx + 1] === 1 ? pc : p[idx + 1];
                    let p0 = s[idx - 1] === 1 ? pc : p[idx - 1];
                    let p3 = s[idx + nx] === 1 ? pc : p[idx + nx];
                    let p2 = s[idx - nx] === 1 ? pc : p[idx - nx];

                    u[idx] -= 0.5 * (p1 - p0) / hx;
                    v[idx] -= 0.5 * (p3 - p2) / hy;
                }
            }
        }
        this.setBnd(1, u);
        this.setBnd(2, v);
    }
}
