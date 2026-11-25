/* ==========================================================================
   Balloonist · config — defaults, load/save, per-feature option merge
   Config file: %APPDATA%/Balloonist/balloonist.config.json
   ========================================================================== */

B.defaultConfig = function () {
    return {
        /* behaviour */
        showPanelOnLoad: true,
        writeLastResult: true,
        confirmBeforeRun: false,

        /* raster analysis (global, shared by every bubble feature) */
        dpi: 144,
        rasterExe: '',
        rasterTimeoutMs: 20000,
        pad: 0.035,
        thr: 200,
        dil: 1,
        h: 0.35,
        debugDump: false,

        /* bubble survey (page-wide detection) */
        minSide: 0,
        minArea: 0,
        maxAspect: 3.5,
        maxArea: 0.09,
        minSidePct: 3,
        minAreaPct: 0.2,
        /* 0 accepts painted-over bubbles that lost their outline; 0.3 asks
           for a real ink outline (untouched manga art) */
        minRingInk: 0,
        /* how completely a bubble fills its bounding box: circles ~0.78,
           clean white boxes ~1.0, faces and paper pockets much less */
        minRectFill: 0.72,
        /* which detector runs:
           blobs  - bright regions enclosed by ink; the only one that works on
                    scans whose bubble interiors are shaded or already lettered
           survey - watershed over the white-paper mask (clean, unlettered art)
           auto   - blobs first, survey when blobs finds nothing */
        detect: 'blobs',
        /* brightness threshold for the blob detector: interior tone in a
           lettered scan reads 160-225, page margins are brighter */
        lightThr: 205,
        /* blob must fill this share of its bounding box (0..1) */
        minFill: 0.5,
        /* how far lettering may sit from the bubble and still be matched */
        matchDist: 24,
        /* hide the copy + debug layers ONCE around the whole page-image run,
           instead of toggling them around every single page */
        hideForExport: true,

        /* new-text-frame defaults (auto frames, smart paste) */
        fontFamily: 'MS Gothic',
        fontSize: 24,
        leading: 0,

        /* layers */
        debugLayer: 'Balloonist Debug',
        cleanLayer: 'Balloonist Clean',
        textLayer: 'Balloonist Text',
        maxPct: 2,
        cleanFillCMYK: [0, 0, 0, 2],
        debugStrokeRGB: [255, 0, 0],

        /* feature defaults (per feature id -> {option: value}) */
        features: {},
        options: {},

        fonts: {
            REG: { family: '', style: '', sizeScale: 1, color: '' },
            SFX: { family: '', style: '', sizeScale: 1, color: '' },
            THOUGHT: { family: '', style: '', sizeScale: 1, color: '' }
        }
    };
};

B.cfg = {};

B.config = (function () {
    function merge(base, extra) {
        if (extra === null || extra === undefined) return base;
        for (var k in extra) {
            if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
            var v = extra[k];
            if (v && typeof v === 'object' && !(Object.prototype.toString.call(v) === '[object Array]') &&
                base[k] && typeof base[k] === 'object' && !(Object.prototype.toString.call(base[k]) === '[object Array]')) {
                merge(base[k], v);
            } else {
                base[k] = v;
            }
        }
        return base;
    }

    return {
        defaults: function () { return B.defaultConfig(); },

        load: function () {
            var d = B.defaultConfig();
            var saved = null;
            try { saved = B.json.read(B.paths.cfg); } catch (e) { saved = null; }
            B.cfg = merge(d, saved || {});
            return B.cfg;
        },

        save: function () {
            try { B.json.write(B.paths.cfg, B.cfg); return true; } catch (e) {
                B.log.error('config save failed: ' + e.message);
                return false;
            }
        },

        /* merged options for one feature: defs <- saved <- override */
        opt: function (id, override) {
            var def = B.reg.get(id);
            var out = {};
            if (def && def.options) {
                for (var i = 0; i < def.options.length; i++) {
                    var o = def.options[i];
                    out[o.key] = (o.def === undefined ? true : o.def);
                }
            }
            var saved = B.cfg.options && B.cfg.options[id];
            if (saved) merge(out, saved);
            if (override) merge(out, override);
            return out;
        },

        /* persist one option value for a feature */
        setOpt: function (id, key, value) {
            if (!B.cfg.options) B.cfg.options = {};
            if (!B.cfg.options[id]) B.cfg.options[id] = {};
            B.cfg.options[id][key] = value;
            B.config.save();
        },

        /* is this feature switched on for the panel? */
        enabled: function (id) {
            var f = B.cfg.features && B.cfg.features[id];
            return f !== false;
        },

        openFile: function () {
            B.paths.cfg.encoding = 'UTF-8';
            if (!B.paths.cfg.exists) B.config.save();
            B.paths.cfg.execute();
        }
    };
})();
