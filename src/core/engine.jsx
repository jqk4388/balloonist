/* ==========================================================================
   Balloonist · registry & runner
   A feature is one file in src/features. It calls B.feature({...}) and the
   panel, the option merge and the error handling appear automatically.
   Delete the file (or set features.<id> = false) to remove it.
   ========================================================================== */

B.reg = (function () {
    var list = [];
    return {
        add: function (def) {
            if (!def || !def.id) throw new Error('feature needs an id');
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === def.id) { list[i] = def; return def; }
            }
            if (typeof def.order !== 'number') def.order = list.length + 1;
            list.push(def);
            return def;
        },
        all: function () { return list; },
        get: function (id) {
            for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
            return null;
        },
        /* features enabled for the panel, in declared order */
        visible: function () {
            var out = [], l = list.slice(0);
            l.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
            for (var i = 0; i < l.length; i++) {
                if (B.config.enabled(l[i].id)) out.push(l[i]);
            }
            return out;
        }
    };
})();

B.feature = function (def) { return B.reg.add(def); };

B.run = function (id, override) {
    /* never let a millimetre-ruler document poison the geometry */
    try { if (B.id && B.id.forcePoints) B.id.forcePoints(); } catch (eUnit) { }
    var f = B.reg.get(id);
    if (!f) throw new Error('没有这个功能: ' + id);

    var t0 = new Date().getTime();
    var cfg = B.config.opt(id, override);
    var doc = B.id.doc();
    var frames = [];
    try { frames = B.id.frames(); } catch (e) { frames = []; }

    var ctx = {
        doc: doc,
        frames: frames,
        cfg: cfg,
        settings: B.cfg,
        id: B.id,
        ops: B.ops,
        info: function (m) { B.log.info('[' + id + '] ' + m); },
        targets: function (force) { return B.ops.targets(doc, frames, B.cfg, force); }
    };

    var res;
    try {
        res = f.run(ctx) || {};
        if (res.ok === undefined) res.ok = true;
    } catch (err) {
        res = { ok: false, error: err.message, line: err.line };
        B.log.error('[' + id + '] ' + err.message + ' @' + err.line);
    }
    res.feature = id;
    res.title = f.title;
    res.ms = new Date().getTime() - t0;

    if (B.cfg.writeLastResult !== false) {
        var light = res;
        try {
            light = {
                feature: res.feature, title: res.title, ok: res.ok, message: res.message,
                error: res.error, ms: res.ms,
                items: res.items ? res.items.length : 0,
                report: res.report ? res.report : null
            };
        } catch (e2) { }
        B.writeJson(B.paths.last, light);
        try { B.writeJson(new File(B.paths.home.fsName + '/last-full.json'), res); } catch (e3) { }
    }
    return res;
};
