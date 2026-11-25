/* ==========================================================================
   Balloonist · geometry helpers
   Rect convention: { x1, y1, x2, y2 } with y growing downward (InDesign pages).
   ========================================================================== */

B.geom = {
    rect: function (x1, y1, x2, y2) {
        return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
    },

    /* InDesign bounds array [y1, x1, y2, x2] -> rect */
    fromBounds: function (b) {
        return B.geom.rect(b[1], b[0], b[3], b[2]);
    },

    /* rect -> InDesign bounds array */
    toBounds: function (r) {
        return [r.y1, r.x1, r.y2, r.x2];
    },

    /* array [x1,y1,x2,y2] (raster format) -> rect */
    fromArray: function (a) {
        return B.geom.rect(a[0], a[1], a[2], a[3]);
    },

    /* rect -> array [x1,y1,x2,y2] (raster format) */
    toArray: function (r) {
        return [r.x1, r.y1, r.x2, r.y2];
    },

    width: function (r) { return r.x2 - r.x1; },
    height: function (r) { return r.y2 - r.y1; },
    cx: function (r) { return (r.x1 + r.x2) / 2; },
    cy: function (r) { return (r.y1 + r.y2) / 2; },

    centerRect: function (w, h, cx, cy) {
        return B.geom.rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    },

    inflate: function (r, d) {
        return B.geom.rect(r.x1 - d, r.y1 - d, r.x2 + d, r.y2 + d);
    },

    /* pull the rect inwards by d on every side */
    deflate: function (r, d) {
        return B.geom.rect(r.x1 + d, r.y1 + d, r.x2 - d, r.y2 - d);
    },

    /* pull the rect inwards by a percentage of its shorter side */
    deflatePct: function (r, pct) {
        var d = Math.min(B.geom.width(r), B.geom.height(r)) * (pct / 100);
        return B.geom.deflate(r, d);
    },

    contains: function (outer, inner, tol) {
        var t = tol || 0;
        return inner.x1 >= outer.x1 - t && inner.y1 >= outer.y1 - t &&
            inner.x2 <= outer.x2 + t && inner.y2 <= outer.y2 + t;
    },

    overlaps: function (a, b) {
        return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    },

    /* gap between two rects, 0 when they touch or overlap */
    gap: function (a, b) {
        var dx = a.x2 < b.x1 ? b.x1 - a.x2 : (b.x2 < a.x1 ? a.x1 - b.x2 : 0);
        var dy = a.y2 < b.y1 ? b.y1 - a.y2 : (b.y2 < a.y1 ? a.y1 - b.y2 : 0);
        return Math.sqrt(dx * dx + dy * dy);
    },

    /* shared area of two rects */
    intersectArea: function (a, b) {
        var w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        var h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        return (w > 0 && h > 0) ? w * h : 0;
    },

    /* distance from a point to the rect (0 when inside) */
    pointDist: function (r, x, y) {
        var dx = x < r.x1 ? r.x1 - x : (x > r.x2 ? x - r.x2 : 0);
        var dy = y < r.y1 ? r.y1 - y : (y > r.y2 ? y - r.y2 : 0);
        return Math.sqrt(dx * dx + dy * dy);
    },

    /* point-in-polygon (ray casting) — poly is [[x,y], ...] in page points */
    pointInPoly: function (poly, x, y) {
        if (!poly || poly.length < 3) return false;
        var inside = false, n = poly.length, j = n - 1, i;
        for (i = 0; i < n; i++) {
            var xi = poly[i][0], yi = poly[i][1];
            var xj = poly[j][0], yj = poly[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
            j = i;
        }
        return inside;
    },

    /* keep an aspect ratio box inside the rect, centred */
    fitInside: function (r, w, h) {
        var s = Math.min(B.geom.width(r) / w, B.geom.height(r) / h);
        return B.geom.centerRect(w * s, h * s, B.geom.cx(r), B.geom.cy(r));
    },

    round: function (v, dp) {
        var m = Math.pow(10, dp === undefined ? 2 : dp);
        return Math.round(v * m) / m;
    },

    fmt: function (v, dp) { return String(B.geom.round(v, dp)); },

    rectText: function (r, dp) {
        return B.geom.fmt(r.x1, dp) + ',' + B.geom.fmt(r.y1, dp) + ',' + B.geom.fmt(r.x2, dp) + ',' + B.geom.fmt(r.y2, dp);
    },

    polyText: function (poly) { return poly.length + ' pts'; }
};
