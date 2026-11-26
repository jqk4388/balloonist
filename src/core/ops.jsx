/* ==========================================================================
   Balloonist · operations shared by features
   targets()  -> page-grouped bubble analysis for the current selection
   place()    -> put a frame on the bubble target (TypeR centring)
   paintClean() -> white shape covering the bubble body, on its own layer
   ========================================================================== */

B.ops = {

    cache: {},
    cacheHits: 0,
    cacheMisses: 0,

    clearCache: function () {
        B.ops.cache = {};
        B.ops.cacheHits = 0;
        B.ops.cacheMisses = 0;
    },

    /* empty the working folder: page PNGs, raster requests/results and the
       stale page-folder snapshots accumulate until someone removes them */
    clearTmp: function () {
        var dir = B.paths.tmp;
        if (!dir || !dir.exists) {
            try { if (dir) dir.create(); } catch (e0) { }
            return 0;
        }
        var list = [], n = 0, i, f;
        try { list = dir.getFiles(); } catch (e1) { list = []; }
        for (i = 0; i < list.length; i++) {
            f = list[i];
            try {
                if (f instanceof Folder) {
                    var kids = f.getFiles(), k;
                    for (k = 0; k < kids.length; k++) {
                        try { kids[k].remove(); n++; } catch (eK) { }
                    }
                    f.remove();
                } else {
                    f.remove(); n++;
                }
            } catch (e2) { B.log.warn('清临时: ' + f.name + ' ' + e2.message); }
        }
        B.ops.clearCache();
        return n;
    },

    /* ---------------------------------------------------------------- */
    targets: function (doc, frames, settings, force) {
        if (!doc) throw new Error('没有打开的文档');
        if (!frames || frames.length === 0) throw new Error('请先选中一个或多个文本框');
        settings = settings || B.cfg;

        var groups = [], i, j, g;
        for (i = 0; i < frames.length; i++) {
            var frame = frames[i];
            var page = B.id.pageOf(frame);
            if (!page) {
                B.log.warn('文本框不在页面上，已跳过: ' + (B.id.contents(frame) || '(空)'));
                continue;
            }
            g = null;
            for (j = 0; j < groups.length; j++) {
                if (groups[j].page.id === page.id) { g = groups[j]; break; }
            }
            if (!g) {
                g = { page: page, pageNumber: B.id.pageNumber(page), items: [] };
                groups.push(g);
            }
            g.items.push({ frame: frame, page: page, local: B.id.localBounds(frame, page) });
        }
        if (groups.length === 0) throw new Error('选中的对象不在任何页面上');

        var scale = (settings.dpi || 144) / 72;

        for (i = 0; i < groups.length; i++) {
            g = groups[i];
            var key = B.ops.cacheKey(g, settings);
            if (!force && B.ops.cache[key]) {
                g.pngPath = B.ops.cache[key].pngPath;
                g.scale = scale;
                for (j = 0; j < g.items.length; j++) g.items[j].res = B.ops.cache[key].results[j];
                B.ops.cacheHits++;
                continue;
            }

            var png = new File(B.paths.tmp.fsName + '/page-' + B.paths.stamp('p' + g.pageNumber) + '.png');
            var exported = B.id.exportPagePng(doc, g.pageNumber, png, settings.dpi || 144);
            if (!exported) throw new Error('页面导出失败: 第 ' + g.pageNumber + ' 页');

            var rects = [];
            for (j = 0; j < g.items.length; j++) rects.push(g.items[j].local);

            var results = B.raster.detect(png.fsName, rects, settings);
            g.pngPath = png.fsName;
            g.scale = scale;
            for (j = 0; j < g.items.length; j++) g.items[j].res = results[j] || null;

            var cached = { pngPath: png.fsName, results: [] };
            for (j = 0; j < g.items.length; j++) cached.results.push(g.items[j].res);
            B.ops.cache[key] = cached;
            B.ops.cacheMisses++;
        }
        return groups;
    },

    cacheKey: function (g, settings) {
        var sig = [];
        for (var i = 0; i < g.items.length; i++) sig.push(B.geom.rectText(g.items[i].local, 2));
        return 'p' + g.page.id + '|' + sig.join(';') + '|' +
            (settings.dpi || 144) + '|' + settings.pad + '|' + settings.thr + '|' + settings.dil + '|' + settings.h;
    },

    /* which layers must disappear before the analyser sees the page: our own
       typesetting, the debug overlay, anything the user configured, the layers
       the frames actually sit on, and layers whose NAME looks like translated
       copy (Text / 文字 / 汉化 / CN / 中文 ...). skipLayer stays visible - it
       is usually the sound-effect lettering that belongs to the art. */
    copyHideNames: function (doc, settings, opts) {
        opts = opts || {};
        settings = settings || B.cfg;
        var names = [], seen = {}, i, n, list;

        function add(name) {
            if (!name) return;
            name = String(name);
            if (seen[name]) return;
            seen[name] = true;
            names.push(name);
        }

        add(settings.textLayer);
        add(settings.debugLayer);
        list = settings.hideLayers || [];
        for (i = 0; i < list.length; i++) {
            if (opts.skipLayer && list[i] === opts.skipLayer) continue;
            add(list[i]);
        }
        list = opts.copyLayers || [];
        for (i = 0; i < list.length; i++) add(list[i]);
        try {
            list = B.id.copyLayerNames(doc, opts.skipLayer);
            for (i = 0; i < list.length; i++) add(list[i]);
        } catch (eAlias) { }
        /* SFX lettering is part of the art when nobody asked to translate it;
           when the caller explicitly keeps that layer, respect it */
        if (!opts.skipLayer || opts.skipLayer !== 'SFX') add('SFX');
        return names;
    },

    /* ---------------------------------------------------------------- */
    /* every bubble on the given pages (no text frame needed) */
    bubbleTargets: function (doc, pages, settings, force, opts) {
        if (!doc) throw new Error('没有打开的文档');
        settings = settings || B.cfg;
        opts = opts || {};
        if (!pages || !pages.length) pages = [B.id.currentPage(doc)];
        var hideNames = (settings.hideForExport === false) ? [] : B.ops.copyHideNames(doc, settings, opts);
        var hideSig = hideNames.length ? hideNames.join(',') : '-';
        var out = [], i;

        /* pass 1: per-page thresholds and cache lookup; collect what needs work */
        var jobs = [], needPages = [];
        for (i = 0; i < pages.length; i++) {
            var page = pages[i];
            if (!page) continue;
            var pn = B.id.pageNumber(page);
            /* thresholds scale with the page: a 362 x 515 pt Chinese manga page
               and a 1403 x 2048 pt weekly page need different minimum sizes */
            var pw = 0, ph = 0;
            try { var pb = page.bounds; pw = pb[3] - pb[1]; ph = pb[2] - pb[0]; } catch (ePB) { }
            if (pw <= 0 || ph <= 0) { pw = 1439; ph = 2048; }
            var shortSide = Math.min(pw, ph), pageArea = pw * ph;
            var minSide = settings.minSide > 0 ? settings.minSide : Math.round((settings.minSidePct || 4) * shortSide / 100 * 10) / 10;
            var minArea = settings.minArea > 0 ? settings.minArea : Math.round((settings.minAreaPct || 0.4) * pageArea / 100 * 10) / 10;
            var eff = B.ops.withSettings({ minSide: minSide, minArea: minArea }, settings);

            /* every knob that changes the analyser output belongs in the key,
               otherwise a dry run with new settings silently reuses old bubbles */
            var key = 'bubbles4|p' + page.id + '|' + (eff.detect || 'auto') + '|' + (eff.dpi || 144) + '|' + eff.pad + '|' +
                minSide + '|' + minArea + '|' + (eff.maxAspect || 0) + '|' +
                (eff.maxArea || 0) + '|' + (eff.minRingInk || 0) + '|' + (eff.minRectFill || 0) + '|' +
                (eff.lightThr || 0) + '|' + (eff.minFill || 0) + '|' +
                (eff.thr || 0) + '|' + (eff.dil || 0) + '|' + (eff.h || 0) +
                '|hide:' + hideSig;
            if (!force && B.ops.cache[key]) { out.push(B.ops.cache[key].group); continue; }
            jobs.push({ page: page, pn: pn, eff: eff, key: key });
            needPages.push(page);
        }
        if (!jobs.length) return out;

        /* pass 2: the analyser must see the ART without our own lettering, so
           hide the copy layers ONCE for the whole run, take every page image,
           then show them ONCE. One EXPORT_ALL call also removes the per-page
           pageString bookkeeping behind "导出的页码设置无效". */
        var first = jobs[0].eff;
        var dpi = first.dpi || 144;
        var files = {}, fk;
        var tExport = new Date();
        var hid = (first.hideForExport === false) ? [] : B.id.hideLayers(doc, hideNames);
        try {
            var batchDir = new Folder(B.paths.tmp.fsName + '/pages-' + B.paths.stamp('batch'));
            if (needPages.length >= 4) {
                var map = B.id.exportPagesPng(doc, needPages, batchDir, 'page', dpi), mi, have = 0;
                for (mi = 0; mi < map.length; mi++) {
                    if (map[mi].file) files[map[mi].page.id] = map[mi].file;
                    else B.log.warn('批量导出缺少第 ' + B.id.pageLabel(map[mi].page) + ' 页');
                }
                for (fk in files) if (files.hasOwnProperty(fk)) have++;
                if (!have) {
                    /* mounts, sections or odd page labels can defeat EXPORT_ALL */
                    B.log.warn('批量导出没有产出图片，改用逐页导出');
                    for (mi = 0; mi < jobs.length; mi++) {
                        var f1 = new File(batchDir.fsName + '/one-' + B.paths.stamp('p' + jobs[mi].pn) + '.png');
                        try { if (B.id.exportPagePng(doc, jobs[mi].page, f1, dpi)) files[jobs[mi].page.id] = f1; }
                        catch (eFb) { B.log.warn('逐页导出 p' + jobs[mi].pn + ': ' + eFb.message); }
                    }
                }
            } else {
                for (var e1 = 0; e1 < jobs.length; e1++) {
                    var f2 = new File(batchDir.fsName + '/one-' + B.paths.stamp('p' + jobs[e1].pn) + '.png');
                    try { if (B.id.exportPagePng(doc, jobs[e1].page, f2, dpi)) files[jobs[e1].page.id] = f2; }
                    catch (eS) { B.log.warn('页面导出 p' + jobs[e1].pn + ': ' + eS.message); }
                }
            }
        } catch (eExpAll) {
            B.log.warn('取页面图片失败: ' + eExpAll.message);
        } finally {
            B.id.showLayers(hid);
        }
        var msExport = new Date() - tExport;

        /* pass 3: analyse page by page, never letting one bad page abort the run */
        for (var j = 0; j < jobs.length; j++) {
            var job = jobs[j];
            var png = files[job.page.id];
            var bubbles = [];
            if (png && png.exists) {
                try { bubbles = B.raster.bubbles(png.fsName, job.eff); }
                catch (eBs) { B.log.warn('气泡检测 p' + job.pn + ': ' + eBs.message); bubbles = []; }
            } else {
                B.log.warn('页面导出失败: 第 ' + job.pn + ' 页（跳过该页）');
            }
            /* drop unusable detections: no safe box, or a border-line sliver */
            var keep = [], bb;
            for (var k = 0; k < bubbles.length; k++) {
                bb = bubbles[k];
                if (!bb || !bb.ok || !bb.fitRect || bb.fitRect.length !== 4) continue;
                if (B.geom.width(B.geom.fromArray(bb.fitRect)) < 12 || B.geom.height(B.geom.fromArray(bb.fitRect)) < 12) continue;
                keep.push(bb);
            }
            var group = { page: job.page, pageNumber: job.pn, pngPath: png ? png.fsName : null, bubbles: keep };
            B.ops.cache[job.key] = { group: group };
            B.ops.cacheMisses++;
            out.push(group);
        }
        B.log.info('取图 ' + needPages.length + ' 页 ' + msExport + ' ms（' + (needPages.length >= 4 ? '一次批量导出' : '逐页导出') + '，隐藏图层一次）');
        return out;
    },

    /* ---------------------------------------------------------------- */
    /* Balloonist Text sits on top, the white covers go right under it, so the
       art stays behind both. Creating layers adds them at the top of the stack,
       so text first, then clean (moved beneath text). */
    layers: function (doc, settings) {
        settings = settings || B.cfg;
        var text = B.id.layerTop(doc, settings.textLayer || 'Balloonist Text');
        var clean = B.id.layerUnder(doc, settings.cleanLayer || 'Balloonist Clean', text);
        return { text: text, clean: clean };
    },

    /* a fresh text frame on the page, in page-local points. The frame must be
       added through the PAGE collection: doc.textFrames.add() always lands on
       the active page, which is why every 气泡铺框 frame used to appear on
       page 1 regardless of the bubble's page. */
    addFrame: function (doc, page, box, layer) {
        var o = B.id.pageOrigin(page);
        var bounds = [box.y1 + o.y, box.x1 + o.x, box.y2 + o.y, box.x2 + o.x];
        var frame;
        try {
            frame = page.textFrames.add({ geometricBounds: bounds });
        } catch (ePageAdd) {
            /* very old builds only expose the document collection */
            frame = doc.textFrames.add({ geometricBounds: bounds });
            try { frame.move(page); } catch (eMove) { B.log.warn('addFrame move: ' + eMove.message); }
        }
        if (layer) {
            try { frame.itemLayer = layer; } catch (eL) { B.log.warn('itemLayer: ' + eL.message); }
        }
        return frame;
    },

    /* ---------------------------------------------------------------- */
    targetCentre: function (res, offsetY) {
        if (!res || !res.ok || !res.center) return null;
        return { x: res.center[0], y: res.center[1] + (offsetY || 0) };
    },

    /* shallow copy of the config with overrides (used by features that need
       their own dpi / thresholds without touching the saved config) */
    withSettings: function (over, base) {
        var s = {}, k, src = base || B.cfg;
        for (k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) s[k] = src[k]; }
        if (over) for (k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) s[k] = over[k]; }
        return s;
    },

    /* ---------------------------------------------------------------- */
    /* Match every frame to a bubble: containment in the bubble's safe box,
       then the safe box plus its outline tolerance, then the nearest bubble
       within maxDist. When the whole imported text block is offset against the
       artwork, estimate that one document-wide shift first and match the
       shifted fingerprint; the destination is still the REAL bubble centre.
       Returns groups [{page, pageNumber, bubbleCount, shift, items:[...]}] */
    assign: function (doc, frames, settings, opts) {
        if (!doc) throw new Error('没有打开的文档');
        settings = settings || B.cfg;
        opts = opts || {};
        var maxDist = opts.maxDist === undefined ? (settings.matchDist || 60) : opts.maxDist;
        var skipLayer = opts.skipLayer || '';
        var byPage = [], i, j, p;

        for (i = 0; i < frames.length; i++) {
            var f = frames[i], pg = null;
            try { pg = B.id.pageOf(f); } catch (ePg) { pg = null; }
            if (!pg) continue;
            /* master-page items live in doc.textFrames too. They are templates
               ("第3话 隐藏之人" on master B), not lettering, and moving one
               would edit every page. Keep them out of the match entirely. */
            try {
                if (pg.parent && pg.parent.constructor && pg.parent.constructor.name === 'MasterSpread') continue;
            } catch (eM) { }
            if (opts.onlyText && !B.id.contents(f)) continue;
            if (opts.skipLayer) {
                var ln = '';
                try { ln = f.itemLayer.name; } catch (eLn) { }
                if (ln === skipLayer) continue;
            }
            var rec = null;
            for (j = 0; j < byPage.length; j++) if (byPage[j].page.id === pg.id) { rec = byPage[j]; break; }
            if (!rec) { rec = { page: pg, pageNumber: B.id.pageNumber(pg), frames: [] }; byPage.push(rec); }
            rec.frames.push(f);
        }

        var pages = [];
        for (p = 0; p < byPage.length; p++) pages.push(byPage[p].page);
        /* which layers actually hold copy on this document? ask the frames
           themselves instead of assuming our own layer name */
        var copyLayers = [], cl, fname;
        for (p = 0; p < frames.length; p++) {
            try {
                fname = frames[p].itemLayer && frames[p].itemLayer.name;
                if (!fname) continue;
                var seen = false;
                for (cl = 0; cl < copyLayers.length; cl++) if (copyLayers[cl] === fname) { seen = true; break; }
                if (!seen) copyLayers.push(fname);
            } catch (eL) { }
        }
        if (opts.skipLayer) {
            cl = copyLayers.length; /* keep the skip layer visible in the export:
                                      its art must not be erased by a hidden SFX */
            while (cl--) if (copyLayers[cl] === opts.skipLayer) copyLayers.splice(cl, 1);
        }
        var found = pages.length ? B.ops.bubbleTargets(doc, pages, settings, opts.force, {
            copyLayers: copyLayers,
            skipLayer: skipLayer
        }) : [];
        var map = {};
        for (p = 0; p < found.length; p++) map['p' + found[p].page.id] = found[p];

        /* ---- thresholds, one place so shift estimation and the real pass
           score with exactly the same rules ---- */
        var ovRatio = opts.minOverlap === undefined ? 0.25 : opts.minOverlap;
        var nearScale = opts.nearScale === undefined ? 2.5 : opts.nearScale;
        var minFitInk = opts.minFitInk === undefined ? 0 : opts.minFitInk;
        var padOpt = opts.bubblePad;
        if (padOpt === undefined || padOpt === null) padOpt = settings.bubblePad;
        if (padOpt === undefined || padOpt === null) padOpt = -1;
        var padPct = opts.bubblePadPct === undefined ? 0.3 : opts.bubblePadPct;

        /* ---- prepare page-local geometry and the bubble match rects ---- */
        var preps = [], frameId = 0, bt, ft, bb, fit, pad, ink, inkLocal, inkW, inkH, inkArea;
        var em, cols, lw, lh, boxArea, local;
        for (p = 0; p < byPage.length; p++) {
            var P = byPage[p], g = map['p' + P.page.id];
            var bubbles = (g && g.bubbles) ? g.bubbles : [];
            bt = [];
            for (var bi = 0; bi < bubbles.length; bi++) {
                bb = bubbles[bi];
                if (!bb || !bb.ok || !bb.fitRect || bb.fitRect.length !== 4) continue;
                fit = B.geom.fromArray(bb.fitRect);
                if (B.geom.width(fit) < 12 || B.geom.height(fit) < 12) continue;
                var fw = B.geom.width(fit), fh = B.geom.height(fit);
                pad = padOpt;
                /* outline tolerance: a little more than the safe box, so copy
                   that only partly covers the balloon still counts as on it */
                if (pad < 0) pad = Math.max(6, Math.min(20, Math.min(fw, fh) * padPct));
                bt.push({
                    res: bb, fit: fit, bbox: B.geom.fromArray(bb.bbox),
                    center: bb.center, fw: fw, fh: fh, pad: pad,
                    match: B.geom.inflate(fit, pad),
                    bboxArea: B.geom.width(B.geom.fromArray(bb.bbox)) * B.geom.height(B.geom.fromArray(bb.bbox))
                });
            }
            ft = [];
            for (j = 0; j < P.frames.length; j++) {
                var fr = P.frames[j];
                local = B.id.localBounds(fr, P.page);
                lw = Math.max(1, B.geom.width(local));
                lh = Math.max(1, B.geom.height(local));
                boxArea = lw * lh;
                ink = null; inkW = 0; inkH = 0; inkArea = 0; cols = 1; em = 8;
                try { ink = B.id.inkBox(fr); } catch (eInk) { ink = null; }
                if (ink) { inkW = ink.w; inkH = ink.h; }
                inkLocal = null;
                if (ink) {
                    var oInk = B.id.pageOrigin(P.page);
                    inkLocal = B.geom.rect(ink.x1 - oInk.x, ink.y1 - oInk.y, ink.x2 - oInk.x, ink.y2 - oInk.y);
                }
                try { cols = fr.lines.length; } catch (eLn2) { cols = 1; }
                try { em = B.id.maxPointSize(fr) || 8; } catch (eEm) { em = 8; }
                if (cols > 1) inkW = Math.max(inkW, cols * em * 1.15);
                inkArea = Math.max(1, inkW * inkH + em * em);
                ft.push({
                    frame: fr, local: local, base: inkLocal || local,
                    inkW: inkW, inkH: inkH, inkArea: inkArea, em: em, cols: cols,
                    lw: lw, lh: lh, boxArea: boxArea,
                    hasInk: !!(ink && inkW > 1 && inkH > 1),
                    id: frameId++
                });
            }
            preps.push({ page: P.page, pageNumber: P.pageNumber, bubbles: bubbles, bt: bt, frames: ft });
        }

        /* ---- candidate list for one frame at one hypothetical shift ---- */
        function matchList(fl, tlist, dx, dy) {
            var probe = B.geom.translate(fl.base, dx, dy);
            var list = [], bi2, t, ovFit, ovMatch, gapFit, gapMatch, score, rank, nw, nh;
            for (bi2 = 0; bi2 < tlist.length; bi2++) {
                t = tlist[bi2];
                if (minFitInk > 0 && t.res.fitInk !== undefined && t.res.fitInk < minFitInk) continue;
                /* strong matches are measured against the REAL safe box; the
                   outline tolerance only widens the weak "near" test, so a
                   caption 10 pt outside a balloon cannot become a strong hit */
                ovFit = B.geom.intersectArea(probe, t.fit);
                ovMatch = B.geom.intersectArea(probe, t.match);
                gapFit = B.geom.gap(probe, t.fit);
                gapMatch = B.geom.gap(probe, t.match);
                score = fl.inkArea > 1 ? ovFit / fl.inkArea : 0;
                rank = 0;
                if (score >= ovRatio) rank = 3;
                else if (ovMatch >= 0.04 * fl.boxArea) rank = 2;
                else if (gapMatch <= maxDist && opts.snapNear === true) {
                    nw = fl.hasInk ? fl.inkW : fl.lw;
                    nh = fl.hasInk ? fl.inkH : fl.lh;
                    if (nw <= t.fw * nearScale && nh <= t.fh * nearScale) rank = 2;
                }
                if (rank === 0) continue;
                list.push({ b: bi2, rank: rank, ov: ovMatch, score: score, gap: gapMatch, gapFit: gapFit, area: t.bboxArea });
            }
            list.sort(function (x, y) {
                if (x.rank !== y.rank) return y.rank - x.rank;
                if (x.score !== y.score) return y.score - x.score;
                if (x.ov !== y.ov) return y.ov - x.ov;
                if (x.gap !== y.gap) return x.gap - y.gap;
                return x.area - y.area;
            });
            return { probe: probe, list: list };
        }

        function candsFor(prep, dx, dy) {
            var out = [], fi2, fl, ml, ic;
            for (fi2 = 0; fi2 < prep.frames.length; fi2++) {
                fl = prep.frames[fi2];
                ml = matchList(fl, prep.bt, dx, dy);
                ic = null;
                if (fl.hasInk) ic = { x: (fl.base.x1 + fl.base.x2) / 2 + dx, y: (fl.base.y1 + fl.base.y2) / 2 + dy };
                out.push({ frame: fl.frame, local: fl.local, list: ml.list, inkC: ic, probe: ml.probe, fl: fl });
            }
            return out;
        }

        /* ---- estimate one document-wide drift by translation voting:
           every frame/bubble pair inside the search radius votes for the
           offset that would put that frame on that bubble. A genuine "the whole
           text block was imported 20 pt to the left" offset collects most of
           the votes in one bin; scattered per-frame corrections do not, and
           then nothing is shifted. ---- */
        /* ---- whole-block import offset -----------------------------------
           The import tool can drop every text frame of a page a few points
           away from its balloon (sometimes tens of points). Rather than
           trusting a nearest-centre vote (frame centres are not balloon
           centres even when the copy is perfectly placed), score candidate
           shifts directly: how much of each frame's ink falls inside a real
           safe box, and how many frames become strong matches. A coarse grid
           finds the basin, a small refinement pass nails it. The destination
           is still the real balloon centre; this shift only moves the
           fingerprint used for matching. ---- */
        function shiftQuality(subPreps, dx, dy) {
            var q = 0, strong = 0, weak = 0, pi, fi, bi, fl, t;
            var radius = opts.shiftPairDist === undefined ? 120 : opts.shiftPairDist;
            for (pi = 0; pi < subPreps.length; pi++) {
                var prep = subPreps[pi];
                var nf = prep.frames.length, nb = prep.bt.length;
                var nearB = [], nearD = [], bubbleF = [], bubbleD = [], fc, bd, d2;
                for (fi = 0; fi < nf; fi++) {
                    fl = prep.frames[fi];
                    nearB[fi] = -1; nearD[fi] = radius;
                    if (!fl.hasInk) continue;
                    fc = { x: (fl.base.x1 + fl.base.x2) / 2 + dx, y: (fl.base.y1 + fl.base.y2) / 2 + dy };
                    for (bi = 0; bi < nb; bi++) {
                        t = prep.bt[bi];
                        if (minFitInk > 0 && t.res.fitInk !== undefined && t.res.fitInk < minFitInk) continue;
                        d2 = (t.center[0] - fc.x) * (t.center[0] - fc.x) + (t.center[1] - fc.y) * (t.center[1] - fc.y);
                        if (d2 < nearD[fi] * nearD[fi]) { nearD[fi] = Math.sqrt(d2); nearB[fi] = bi; }
                    }
                }
                /* one balloon may only claim the frame that is closest to it:
                   a shift that stuffs many frames into one big blob therefore
                   scores much lower than the true offset, where every frame
                   has its own nearby balloon. */
                for (bi = 0; bi < nb; bi++) { bubbleF[bi] = -1; bubbleD[bi] = radius; }
                for (fi = 0; fi < nf; fi++) {
                    bi = nearB[fi];
                    if (bi < 0) continue;
                    if (nearD[fi] < bubbleD[bi]) { bubbleD[bi] = nearD[fi]; bubbleF[bi] = fi; }
                }
                for (fi = 0; fi < nf; fi++) {
                    bi = nearB[fi];
                    if (bi < 0 || bubbleF[bi] !== fi) continue;
                    fl = prep.frames[fi]; t = prep.bt[bi];
                    var ax1 = fl.base.x1 + dx, ay1 = fl.base.y1 + dy;
                    var ax2 = fl.base.x2 + dx, ay2 = fl.base.y2 + dy;
                    var ox = Math.min(ax2, t.fit.x2) - Math.max(ax1, t.fit.x1);
                    var oy = Math.min(ay2, t.fit.y2) - Math.max(ay1, t.fit.y1);
                    var ov = (ox > 0 && oy > 0) ? ox * oy : 0;
                    var sc = fl.inkArea > 1 ? ov / fl.inkArea : 0;
                    var cx = (fl.base.x1 + fl.base.x2) / 2 + dx;
                    var cy = (fl.base.y1 + fl.base.y2) / 2 + dy;
                    var inBox = cx >= t.bbox.x1 - t.pad && cx <= t.bbox.x2 + t.pad &&
                        cy >= t.bbox.y1 - t.pad && cy <= t.bbox.y2 + t.pad;
                    if (!inBox && ov <= 0) continue;
                    q += 1 + (sc >= ovRatio ? 0.5 : 0);
                    if (sc >= ovRatio) strong++; else weak++;
                }
            }
            return { q: q, strong: strong, weak: weak };
        }

        function estimateShift(subPreps) {
            var total = 0, pi, fi, fl;
            for (pi = 0; pi < subPreps.length; pi++) {
                for (fi = 0; fi < subPreps[pi].frames.length; fi++) {
                    fl = subPreps[pi].frames[fi];
                    if (fl.hasInk) total++;
                }
            }
            if (!total || total < (opts.shiftMinFrames === undefined ? 4 : opts.shiftMinFrames)) return null;
            var range = opts.shiftSearch === undefined ? 160 : opts.shiftSearch;
            var step = opts.shiftStep === undefined ? 16 : opts.shiftStep;
            var fine = opts.shiftRefine === undefined ? 4 : opts.shiftRefine;
            var base = shiftQuality(subPreps, 0, 0), best = base, bx = 0, by = 0;
            var dx2, dy2, ev, mag, sc, bestMag = 0, bestScore = base.q;
            var magPen = opts.shiftMagPenalty === undefined ? 0.01 : opts.shiftMagPenalty;
            for (dx2 = -range; dx2 <= range; dx2 += step) {
                for (dy2 = -range; dy2 <= range; dy2 += step) {
                    if (dx2 === 0 && dy2 === 0) continue;
                    ev = shiftQuality(subPreps, dx2, dy2);
                    mag = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    sc = ev.q - (Math.abs(dx2) + Math.abs(dy2)) * magPen;
                    if (sc > bestScore + 0.0001 || (sc > bestScore - 0.0001 && mag < bestMag)) {
                        best = ev; bestScore = sc; bx = dx2; by = dy2; bestMag = mag;
                    }
                }
            }
            /* refine ± one coarse step around the winner */
            var lo = { x: bx - step, y: by - step }, hi = { x: bx + step, y: by + step };
            for (dx2 = lo.x; dx2 <= hi.x; dx2 += fine) {
                for (dy2 = lo.y; dy2 <= hi.y; dy2 += fine) {
                    ev = shiftQuality(subPreps, dx2, dy2);
                    mag = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    sc = ev.q - (Math.abs(dx2) + Math.abs(dy2)) * magPen;
                    if (sc > bestScore + 0.0001 || (sc > bestScore - 0.0001 && mag < bestMag)) {
                        best = ev; bestScore = sc; bx = dx2; by = dy2; bestMag = mag;
                    }
                }
            }
            var minGain = opts.shiftMinGain === undefined ? Math.max(1, Math.round(total * 0.03)) : opts.shiftMinGain;
            if (opts.shiftDebug === true) {
                B.log.info('偏移试算：框 ' + total + '，原样 ' + B.geom.round(base.q, 2) + ' 分（' +
                    base.strong + ' 强 ' + base.weak + ' 弱），最佳 ' + bx + ',' + by + ' ' +
                    B.geom.round(best.q, 2) + ' 分（' + best.strong + ' 强 ' + best.weak + ' 弱，扣除位移 ' +
                    B.geom.round(bestScore, 2) + '）');
                B.log.info('  结论 ' + (bestScore >= base.q + minGain && best.strong >= base.strong + 1 &&
                    (base.strong > 0 || best.strong >= 2) && bestMag >= 3 ? '采用' : '不采用') +
                    '（需至少 +' + minGain + ' 分且多 1 个强命中）');
            }
            if (bestScore < base.q + minGain) return null;
            /* a page that is already aligned can gain one accidental overlap
               from a shift, so require at least one extra strong hit; when
               nothing hits at all, two are needed (see below). */
            if (best.strong < base.strong + 1) return null;
            if (base.strong === 0 && best.strong < 2) return null;
            if (bestMag < 3) return null;
            return { x: bx, y: by, strong: best.strong, weak: best.weak, base: base, total: total, q: best.q };
        }

        var sx = opts.shiftX || 0, sy = opts.shiftY || 0, shiftMode = (sx || sy) ? 'manual' : 'none';
        var pi0;
        if (shiftMode === 'manual') {
            for (pi0 = 0; pi0 < preps.length; pi0++) preps[pi0].shift = { x: sx, y: sy, mode: 'manual' };
        } else if (opts.autoShift === true) {
            for (pi0 = 0; pi0 < preps.length; pi0++) {
                var si = estimateShift([preps[pi0]]);
                if (si) {
                    preps[pi0].shift = { x: si.x, y: si.y, mode: 'auto' };
                    B.log.info('第 ' + preps[pi0].pageNumber + ' 页整体偏移补偿 ' +
                        B.geom.round(si.x, 1) + ',' + B.geom.round(si.y, 1) +
                        ' pt（命中 ' + si.strong + ' 强 + ' + si.weak + ' 弱，共 ' + si.total + ' 框）');
                } else {
                    preps[pi0].shift = { x: 0, y: 0, mode: 'none' };
                }
            }
        } else {
            for (pi0 = 0; pi0 < preps.length; pi0++) preps[pi0].shift = { x: 0, y: 0, mode: 'none' };
        }

        var groups = [];
        for (p = 0; p < byPage.length; p++) {
            var PREP = preps[p];
            var PSX = PREP.shift.x, PSY = PREP.shift.y, PSMODE = PREP.shift.mode;
            var cad = candsFor(PREP, PSX, PSY);
            /* two passes so one bubble never hosts two lettering blocks:
               1) build every (frame, bubble) candidate with its score,
               2) hand out bubbles greedily, strongest score first. A caption
               label that merely sits near a bubble therefore loses to the
               frame that actually overlaps it, and stays unmatched. */
            cad.sort(function (x, y) {
                var ax = x.list.length ? x.list[0] : null, ay = y.list.length ? y.list[0] : null;
                if (!ax && !ay) return 0;
                if (!ax) return 1;
                if (!ay) return -1;
                if (ax.rank !== ay.rank) return ay.rank - ax.rank;
                if (ax.score !== ay.score) return ay.score - ax.score;
                if (ax.ov !== ay.ov) return ay.ov - ax.ov;
                return ax.gap - ay.gap;
            });
            /* two bubbles can overlap on this art (a split oval reads as two
               blobs); if both were handed out, their copy lands on top of each
               other, so a claimed destination box also blocks its neighbours */
            var used = {}, picked = {}, claimed = [], gcount = {}, groupBox = {}, qq;
            var clashRatio = opts.clashRatio === undefined ? 0.3 : opts.clashRatio;
            for (j = 0; j < cad.length; j++) {
                var c = cad[j];
                for (var cb = 0; cb < c.list.length; cb++) {
                    var cd = c.list[cb];
                    if (used[cd.b]) continue;
                    var dbox = PREP.bt[cd.b].fit;
                    var clash = false, q;
                    for (q = 0; q < claimed.length; q++) {
                        if (B.geom.intersectArea(claimed[q], dbox) > clashRatio * B.geom.width(dbox) * B.geom.height(dbox)) { clash = true; break; }
                    }
                    if (clash) continue;
                    used[cd.b] = true;
                    gcount[cd.b] = 1;
                    groupBox[cd.b] = c.local;
                    claimed.push(dbox);
                    picked[j] = cd;
                    break;
                }
            }
            /* second pass: a big balloon can hold two lettering blocks side by
               side, or a connected balloon was split into an upper and a lower
               frame on import. The first pass may only hand the bubble to one
               of them; re-attach the others when their GLYPHS sit inside the
               same bubble, so the group can be translated as one block. */
            var maxPer = opts.maxPerBubble === undefined ? 3 : opts.maxPerBubble;
            var groupCover = opts.groupCover === undefined ? 0.45 : opts.groupCover;
            for (j = 0; j < cad.length; j++) {
                if (picked[j]) continue;
                var c3 = cad[j];
                if (!c3.inkC) continue;
                var bestB = -1, bestD = 0, bi3, t3, d3, box3;
                for (bi3 = 0; bi3 < PREP.bt.length; bi3++) {
                    t3 = PREP.bt[bi3];
                    if (!used[bi3] || !groupBox[bi3]) continue;
                    if (gcount[bi3] >= maxPer) continue;
                    if (c3.fl.inkW > t3.fw * nearScale * 1.3 || c3.fl.inkH > t3.fh * nearScale * 1.3) continue;
                    /* the candidate itself must sit mostly inside the balloon.
                       A connected balloon (two lobes read as one blob) has a
                       bbox that spans both lobes, so a lower frame may hang a
                       few points past the fitted lobe; allow that overhang,
                       but not a neighbouring block that merely touches. */
                    /* compare the SHIFTED frame with the real balloon: this
                       page may be compensating a whole-block import offset. */
                    box3 = B.geom.inflate(t3.res.leak ? t3.fit : t3.bbox, t3.pad);
                    var candBox = {
                        x1: c3.local.x1 + PSX, y1: c3.local.y1 + PSY,
                        x2: c3.local.x2 + PSX, y2: c3.local.y2 + PSY
                    };
                    var candArea = Math.max(1, (candBox.x2 - candBox.x1) * (candBox.y2 - candBox.y1));
                    var cover = B.geom.intersectArea(candBox, box3) / candArea;
                    var gtol = Math.min(18, t3.pad + 8);
                    if (cover < groupCover || !B.geom.contains(box3, candBox, gtol)) continue;
                    d3 = B.geom.pointDist(t3.fit, c3.inkC.x + PSX, c3.inkC.y + PSY);
                    if (bestB < 0 || d3 < bestD) { bestB = bi3; bestD = d3; }
                }
                if (bestB < 0) continue;
                /* keep its measured rank when the pair was a candidate; when
                   it only became visible after the shift, treat it as a near
                   match so the weak-shift guard below can still veto it */
                var foundCd = null;
                for (bi3 = 0; bi3 < c3.list.length; bi3++) if (c3.list[bi3].b === bestB) { foundCd = c3.list[bi3]; break; }
                picked[j] = foundCd || { b: bestB, rank: 2, ov: 0, score: 0, gap: 0, gapFit: 0, area: PREP.bt[bestB].bboxArea };
                gcount[bestB]++;
                groupBox[bestB] = {
                    x1: Math.min(groupBox[bestB].x1, c3.local.x1),
                    y1: Math.min(groupBox[bestB].y1, c3.local.y1),
                    x2: Math.max(groupBox[bestB].x2, c3.local.x2),
                    y2: Math.max(groupBox[bestB].y2, c3.local.y2)
                };
            }
            var items = [];
            for (j = 0; j < cad.length; j++) {
                var c2 = cad[j], pk = picked[j], r2 = pk ? PREP.bubbles[pk.b] : null;
                items.push({
                    frame: c2.frame, page: PREP.page, pageNumber: PREP.pageNumber, local: c2.local,
                    res: r2, b: pk ? pk.b : -1,
                    match: r2 ? (pk.rank === 3 ? 'overlap' : 'near') : 'none',
                    rank: pk ? pk.rank : 0, score: pk ? pk.score : 0,
                    fitInk: r2 ? r2.fitInk : 0,
                    dist: pk ? B.geom.round(pk.gapFit, 1) : -1,
                    probeShift: pk ? [B.geom.round(PSX, 1), B.geom.round(PSY, 1)] : null
                });
            }
            /* one bubble, several frames: keep their relative arrangement and
               centre the whole group on the bubble (a single target point per
               bubble would stack the two blocks on top of each other) */
            var offsetX = opts.offsetX || 0, offsetY = opts.offsetY || 0;
            /* a weak (rank-2) match only grazes the bubble. On an already
               lettered page that is usually a caption or a false-positive
               blob; snapping it can throw copy 30 pt across the art (page 9
               of the sample). Leave it alone unless the shift is small. The
               distance is measured AFTER the whole-block compensation, so a
               coherent import offset does not veto every frame. */
            var weakMax = opts.maxWeakShift === undefined ? 12 : opts.maxWeakShift;
            if (weakMax > 0) {
                for (j = 0; j < items.length; j++) {
                    var wp = picked[j];
                    if (!wp || wp.rank >= 3 || wp.b < 0) continue;
                    var wc = PREP.bt[wp.b].center, wl = cad[j].local;
                    var wdx = wc[0] + offsetX - ((wl.x1 + wl.x2) / 2 + PSX);
                    var wdy = wc[1] + offsetY - ((wl.y1 + wl.y2) / 2 + PSY);
                    if (Math.sqrt(wdx * wdx + wdy * wdy) > weakMax) {
                        picked[j] = null;
                        items[j].res = null; items[j].b = -1; items[j].match = 'none';
                        items[j].rank = 0; items[j].score = 0; items[j].fitInk = 0;
                        items[j].dist = -1; items[j].probeShift = null;
                    }
                }
            }
            var byBubble = {}, gi;
            for (j = 0; j < items.length; j++) {
                var itj = items[j];
                if (!itj.res) continue;
                var bj = itj.b;
                if (!byBubble[bj]) byBubble[bj] = [];
                byBubble[bj].push(itj);
            }
            for (gi in byBubble) {
                if (!byBubble.hasOwnProperty(gi)) continue;
                var grp = byBubble[gi], n = grp.length;
                if (n === 0) continue;
                if (n > 1) {
                    /* the group's visual centre is the mean of the block
                       centres, NOT the centre of the union box: two blocks
                       of unequal height would drag the union box upwards
                       (the taller frame owns both the top and the bottom),
                       and the whole pair would be shifted down by half the
                       height difference. */
                    var gcx = 0, gcy = 0;
                    for (j = 0; j < n; j++) {
                        var q = grp[j].local;
                        gcx += (q.x1 + q.x2) / 2; gcy += (q.y1 + q.y2) / 2;
                    }
                    var gc = { x: gcx / n, y: gcy / n };
                    /* a connected balloon is one blob with two lobes: centre
                       the pair on the whole blob, not on the fitted lobe of
                       the first frame, or the lower block hangs out. */
                    var rc = grp[0].res.center;
                    var bb = grp[0].res.bbox;
                    if (bb && bb.length === 4) rc = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
                    var dxg = rc[0] + offsetX - gc.x, dyg = rc[1] + offsetY - gc.y;
                    for (j = 0; j < n; j++) {
                        var qq2 = grp[j].local;
                        grp[j].target = { x: (qq2.x1 + qq2.x2) / 2 + dxg, y: (qq2.y1 + qq2.y2) / 2 + dyg };
                        grp[j].groupCount = n;
                    }
                } else {
                    var r1 = grp[0].res.center, l1 = grp[0].local;
                    grp[0].target = { x: r1[0] + offsetX, y: r1[1] + offsetY };
                    grp[0].groupCount = 1;
                }
            }
            groups.push({
                page: PREP.page, pageNumber: PREP.pageNumber, bubbleCount: PREP.bubbles.length,
                shift: { x: B.geom.round(PSX, 2), y: B.geom.round(PSY, 2), mode: PSMODE },
                items: items
            });
        }
        return groups;
    },

    /* put one frame on the bubble: returns a report object */
    place: function (item, opts) {
        opts = opts || {};
        var res = item.res;
        if (!res || !res.ok) return { frame: item.frame, ok: false, reason: '未识别到气泡' };

        var before = item.local;
        /* assign() already computed the exact destination: a bubble centre for
           a lone frame, or "keep my place in the group" for the second column
           of a multi-frame balloon */
        var target = item.target || B.ops.targetCentre(res, opts.centreOffsetY);
        var box;

        /* TRANSLATION ONLY - the align pass for a finished lettering job must
           not touch a single text attribute (paragraph alignment, vertical
           justification, first baseline, insets, font size). TypeR moves the
           ink box too: byInk measures where the glyphs really sit, so the
           visible type lands on the bubble centroid even when the frame has
           padding of its own. */
        if (opts.moveOnly) {
            var w0 = Math.max(10, B.geom.width(before)), h0 = Math.max(10, B.geom.height(before));
            var box0 = B.geom.centerRect(w0, h0, target.x, target.y);
            try {
                B.id.setLocalBounds(item.frame, item.page, box0);
            } catch (eMo) {
                return { frame: item.frame, ok: false, reason: '设置定界框失败: ' + eMo.message };
            }
            var rep0 = {
                frame: item.frame, ok: true, moveOnly: true, viaInk: false,
                from: B.geom.toArray(before), to: B.geom.toArray(box0),
                centre: [B.geom.round(target.x, 2), B.geom.round(target.y, 2)]
            };
            if (opts.byInk !== false) {
                try {
                    var ink = B.id.inkBox(item.frame);
                    if (ink && ink.w > 1 && ink.h > 1) {
                        var o = B.id.pageOrigin(item.page);
                        var cx = (ink.x1 + ink.x2) / 2 - o.x;
                        var cy = (ink.y1 + ink.y2) / 2 - o.y;
                        var dx = target.x - cx, dy = target.y - cy;
                        if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
                            var box1 = { x1: box0.x1 + dx, y1: box0.y1 + dy, x2: box0.x2 + dx, y2: box0.y2 + dy };
                            B.id.setLocalBounds(item.frame, item.page, box1);
                            rep0.to = B.geom.toArray(box1);
                            rep0.viaInk = true;
                            rep0.inkShift = [B.geom.round(dx, 2), B.geom.round(dy, 2)];
                        }
                    }
                } catch (eInk) { B.log.warn('inkBox: ' + eInk.message); }
            }
            return rep0;
        }

        if (opts.fitToBubble && res.fitRect && res.fitRect.length === 4) {
            box = B.geom.fromArray(res.fitRect);
            /* a degenerate fit (a few points wide) throws "无法设置定界框" */
            if (B.geom.width(box) < 10 || B.geom.height(box) < 10) box = null;
        }
        if (!box) {
            var w = Math.max(12, B.geom.width(before) || 60);
            var h = Math.max(12, B.geom.height(before) || 40);
            box = B.geom.centerRect(w, h, target.x, target.y);
        }

        try {
            B.id.setLocalBounds(item.frame, item.page, box);
        } catch (eBox) {
            return { frame: item.frame, ok: false, reason: '设置定界框失败: ' + eBox.message };
        }
        if (opts.moveOnly !== true && opts.forceJustify !== false) B.id.justify(item.frame, opts.zeroInset !== false);

        var report = {
            frame: item.frame, ok: true,
            from: B.geom.toArray(before), to: B.geom.toArray(box),
            centre: [B.geom.round(target.x, 2), B.geom.round(target.y, 2)],
            fitted: !!(opts.fitToBubble)
        };

        if (opts.fitSize) {
            /* fit-object-to-bubble: the safe rect is the target, and both the
               frame box and the measured ink must stay inside it.  The old
               path only grew type until `overflows` said stop; with
               auto-sizing on, InDesign shrugged and let the frame grow far
               outside the bubble. */
            var rf = B.id.fitFrameToBubble(item.frame, item.page, box, opts.minPct, opts.maxPct, opts.step);
            report.shrink = rf;
            if (rf.overflow) report.warning = '缩到最小字号仍溢出 (' + rf.to + 'pt)';
        } else if (opts.fitToBubble && opts.shrink) {
            /* alignAll path: geometry ladder, because `overflows` lies for
               vertical CJK stories that already spill outside their bubble */
            var r = opts.shrinkMode === 'flag'
                ? B.id.shrinkToFit(item.frame, opts.minPct, opts.step)
                : B.id.fitInkToBox(item.frame, box, opts.minPct === undefined ? 0.7 : opts.minPct);
            report.shrink = r;
            /* still oversized at the floor: the frame did move, so report it
               as placed-with-warning instead of a hard failure */
            if (r.overflow) report.warning = '缩到最小字号仍溢出 (' + r.to + 'pt)';
        }
        return report;
    },

    /* ---------------------------------------------------------------- */
    paintClean: function (doc, item, settings) {
        var res = item.res;
        if (!res || !res.ok || !res.poly) return null;
        var cmyk = settings.cleanFillCMYK || [0, 0, 0, 2];
        /* a pure 0% white renders as "no ink" and leaves the art visible in
           the PNG export; lift it to 2% K so the cover actually knocks out */
        if (cmyk[0] === 0 && cmyk[1] === 0 && cmyk[2] === 0 && cmyk[3] === 0) cmyk = [0, 0, 0, 2];
        var white = B.id.processColor(doc, 'Balloonist White', cmyk);
        var none = B.id.noneSwatch(doc);
        var layer = B.ops.layers(doc, settings).clean;
        if (!layer) return null;
        var shape = B.id.addPolygon(layer, B.id.localPath(res.poly, item.page), none, white, 0, item.page);
        if (shape) {
            /* a fresh polygon inherits fillTint -1 ("no tint"), which renders
               the white fill invisible; force a solid 100% cover */
            try { shape.fillTint = 100; } catch (eTint) { }
            try { shape.strokeWeight = 0; } catch (e) { }
        }
        return shape;
    },

    /* ---------------------------------------------------------------- */
    describe: function (res) {
        if (!res) return '无结果';
        if (!res.ok) return '未识别 (leak=' + res.leak + ')';
        return '面积 ' + Math.round(res.area / (res.scale || 4)) + 'pt² · 重心 ' +
            B.geom.round(res.center[0], 1) + ',' + B.geom.round(res.center[1], 1) +
            ' · 安全框 ' + B.geom.rectText(B.geom.fromArray(res.fitRect), 1);
    }
};
