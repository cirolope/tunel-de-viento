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

        // Obstacle mask and velocities
        this.s = new Float32Array(this.numCells);
        this.s.fill(0); // All fluid initially
        this.obsU = new Float32Array(this.numCells);
        this.obsV = new Float32Array(this.numCells);

        this.iter = 10; // Solver iterations for pressure (Poisson)
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
        // Option: Slowly pull all fluid velocity towards windSpeed (acting like a global wind drive)
        for (let i = 0; i < this.numCells; i++) {
            if (this.s[i] === 0) {
                // dampen towards windSpeed a little to prevent stalling
                this.u[i] = this.u[i] * 0.99 + windSpeed * 0.01;
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

        // Project (make divergence free & calculate pressure)
        this.project(this.u, this.v, this.p, this.u0); // u0 is used as div temp array

        // Move dye
        this.advect(0, this.d, this.d0, this.u, this.v, dt);

        // Continuous input stream
        this.injectWind(windSpeed, dt);
    }

    injectWind(windSpeed, dt) {
        const tunnelInletWidth = Math.floor(this.ny);
        for (let j = 0; j < tunnelInletWidth; j++) {
            // Inject velocity in first few columns
            for (let i = 0; i < 4; i++) {
                const idx = this.IX(i, j);
                if (this.s[idx] === 0) {
                    this.u[idx] = windSpeed;
                    this.v[idx] = 0;
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
        let cRecip = 1.0 / c;
        for (let k = 0; k < this.iter; k++) {
            for (let j = 1; j < this.ny - 1; j++) {
                for (let i = 1; i < this.nx - 1; i++) {
                    if (this.s[this.IX(i, j)] === 0) { // Only solve if not obstacle
                        x[this.IX(i, j)] =
                            (x0[this.IX(i, j)] +
                                a * (x[this.IX(i + 1, j)] +
                                    x[this.IX(i - 1, j)] +
                                    x[this.IX(i, j + 1)] +
                                    x[this.IX(i, j - 1)])) *
                            cRecip;
                    } else {
                        x[this.IX(i, j)] = 0;
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
        let i0, j0, i1, j1;
        let x, y, s0, t0, s1, t1;
        let dt0x = dt * (this.nx - 2);
        let dt0y = dt * (this.ny - 2);

        for (let j = 1; j < this.ny - 1; j++) {
            for (let i = 1; i < this.nx - 1; i++) {
                if (this.s[this.IX(i, j)] === 1) continue; // Skip obstacles

                x = i - dt0x * u[this.IX(i, j)];
                y = j - dt0y * v[this.IX(i, j)];

                if (x < 0.5) x = 0.5;
                if (x > this.nx + 0.5) x = this.nx + 0.5;
                i0 = Math.floor(x);
                i1 = i0 + 1;

                if (y < 0.5) y = 0.5;
                if (y > this.ny + 0.5) y = this.ny + 0.5;
                j0 = Math.floor(y);
                j1 = j0 + 1;

                s1 = x - i0;
                s0 = 1.0 - s1;
                t1 = y - j0;
                t0 = 1.0 - t1;

                // Bilinear interpolation
                d[this.IX(i, j)] =
                    s0 * (t0 * d0[this.IX(i0, j0)] + t1 * d0[this.IX(i0, j1)]) +
                    s1 * (t0 * d0[this.IX(i1, j0)] + t1 * d0[this.IX(i1, j1)]);
            }
        }
        this.setBnd(b, d);
    }

    project(u, v, p, div) {
        let hx = 1.0 / this.nx;
        let hy = 1.0 / this.ny;

        for (let j = 1; j < this.ny - 1; j++) {
            for (let i = 1; i < this.nx - 1; i++) {
                if (this.s[this.IX(i, j)] === 0) {
                    div[this.IX(i, j)] =
                        -0.5 *
                        (u[this.IX(i + 1, j)] - u[this.IX(i - 1, j)]) * hx -
                        0.5 *
                        (v[this.IX(i, j + 1)] - v[this.IX(i, j - 1)]) * hy;
                    p[this.IX(i, j)] = 0;
                }
            }
        }

        this.setBnd(0, div);
        this.setBnd(0, p);

        // Solve Poisson equation for pressure
        this.linSolve(0, p, div, 1, 4);

        for (let j = 1; j < this.ny - 1; j++) {
            for (let i = 1; i < this.nx - 1; i++) {
                if (this.s[this.IX(i, j)] === 0) {
                    let p1 = p[this.IX(i + 1, j)];
                    let p0 = p[this.IX(i - 1, j)];
                    let p3 = p[this.IX(i, j + 1)];
                    let p2 = p[this.IX(i, j - 1)];

                    // Simple boundary condition handling for pressure derivative
                    if (this.s[this.IX(i + 1, j)] === 1) p1 = p[this.IX(i, j)];
                    if (this.s[this.IX(i - 1, j)] === 1) p0 = p[this.IX(i, j)];
                    if (this.s[this.IX(i, j + 1)] === 1) p3 = p[this.IX(i, j)];
                    if (this.s[this.IX(i, j - 1)] === 1) p2 = p[this.IX(i, j)];

                    u[this.IX(i, j)] -= 0.5 * (p1 - p0) / hx;
                    v[this.IX(i, j)] -= 0.5 * (p3 - p2) / hy;
                }
            }
        }
        this.setBnd(1, u);
        this.setBnd(2, v);
    }
}
