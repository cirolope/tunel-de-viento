/**
 * Generates coordinates for a NACA 4-digit airfoil.
 * E.g. "2412" -> m=0.02, p=0.4, t=0.12
 */
class AirfoilGenerator {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Parse 4-digit string to parameters
     */
    parseNACA(nacaString) {
        if (!/^\d{4}$/.test(nacaString)) {
            return { m: 0, p: 0, t: 0.12 }; // default to 0012 on error
        }
        return {
            m: parseInt(nacaString.charAt(0)) / 100,
            p: parseInt(nacaString.charAt(1)) / 10,
            t: parseInt(nacaString.substring(2, 4)) / 100
        };
    }

    /**
     * Generate coordinates for upper and lower surfaces.
     * @param {string} nacaString - 4 digit string
     * @param {number} numPoints - number of points per surface.
     * @returns {Array<{x, y}>} Array of points (trailing edge -> leading edge -> trailing edge)
     */
    generate(nacaString, numPoints = 100) {
        if (this.cache.has(nacaString + '_' + numPoints)) {
            return this.cache.get(nacaString + '_' + numPoints);
        }

        const { m, p, t } = this.parseNACA(nacaString);

        const upper = [];
        const lower = [];

        for (let i = 0; i <= numPoints; i++) {
            // Use cosine spacing to cluster points near leading and trailing edges
            const beta = Math.PI * (i / numPoints);
            const x = 0.5 * (1 - Math.cos(beta));

            // Thickness distribution
            // yt = 5t * (0.2969*sqrt(x) - 0.1260*x - 0.3516*x^2 + 0.2843*x^3 - 0.1015*x^4)
            // Or -0.1036 for closed trailing edge. We use -0.1015 (open TE)
            const yt = 5 * t * (
                0.2969 * Math.sqrt(x) -
                0.1260 * x -
                0.3516 * Math.pow(x, 2) +
                0.2843 * Math.pow(x, 3) -
                0.1015 * Math.pow(x, 4)
            );

            // Camber line and gradient
            let yc = 0;
            let dyc_dx = 0;

            if (p > 0) {
                if (x >= 0 && x <= p) {
                    yc = (m / Math.pow(p, 2)) * (2 * p * x - Math.pow(x, 2));
                    dyc_dx = (2 * m / Math.pow(p, 2)) * (p - x);
                } else if (x > p && x <= 1) {
                    yc = (m / Math.pow(1 - p, 2)) * (1 - 2 * p + 2 * p * x - Math.pow(x, 2));
                    dyc_dx = (2 * m / Math.pow(1 - p, 2)) * (p - x);
                }
            }

            const theta = Math.atan(dyc_dx);

            // Upper surface
            const xu = x - yt * Math.sin(theta);
            const yu = yc + yt * Math.cos(theta);

            // Lower surface
            const xl = x + yt * Math.sin(theta);
            const yl = yc - yt * Math.cos(theta);

            upper.push({ x: xu, y: yu });
            lower.push({ x: xl, y: yl });
        }

        // Combine: Trail -> Lead (upper), Lead -> Trail (lower)
        // Reverse upper so it goes from TE to LE
        upper.reverse();

        const coords = [...upper, ...lower.slice(1)]; // Skip one duplicate leading edge point

        this.cache.set(nacaString + '_' + numPoints, coords);
        return coords;
    }
}
