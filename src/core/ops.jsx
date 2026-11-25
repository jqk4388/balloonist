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

    /* ---------------------------------------------------------------- */
    /* every bubble on the given pages (no text frame needed) */
    bubbleTargets: function (doc, pages, settings, force) {
        if (!doc) throw new Error('没有打开的文档');
        settings = settings || B.cfg;
        if (!pages || !pages.length) pages = [B.id.currentPage(doc)];
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
                (eff.thr || 0) + '|' + (eff.dil || 0) + '|' + (eff.h || 0);
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
        var hideNames = [first.textLayer, first.debugLayer, 'Text', 'SFX'];
        if (first.hideLayers && first.hideLayers.length) {
            for (var hl = 0; hl < first.hideLayers.length; hl++) hideNames.push(first.hideLayers[hl]);
        }
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
    /* Match every frame to a bubble: containment first (120-pt body polygon),
       then bounding box, then the nearest bubble within maxDist points.
       Returns groups [{page, pageNumber, bubbleCount, items:[...]}] where each
       item is {frame, page, pageNumber, local, res, match, dist}. */
    assign: function (doc, frames, settings, opts) {
        if (!doc) throw new Error('没有打开的文档');
        settings = settings || B.cfg;
        opts = opts || {};
        var maxDist = opts.maxDist === undefined ? (settings.matchDist || 60) : opts.maxDist;
        var skipLayer = opts.skipLayer || '';
        var byPage = [], i, j;

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

        var pages = [], p;
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
        var found = pages.length ? B.ops.bubbleTargets(doc, pages, settings, opts.force) : [];
        var map = {};
        for (p = 0; p < found.length; p++) map['p' + found[p].page.id] = found[p];

        var groups = [];
        for (p = 0; p < byPage.length; p++) {
            var P = byPage[p], g = map['p' + P.page.id];
            var bubbles = (g && g.bubbles) ? g.bubbles : [];
            /* two passes so one bubble never hosts two lettering blocks:
               1) build every (frame, bubble) candidate with its score,
               2) hand out bubbles greedily, strongest score first. A caption
               label that merely sits near a bubble therefore loses to the
               frame that actually overlaps it, and stays unmatched. */
            var minFitInk = opts.minFitInk === undefined ? 0 : opts.minFitInk;
            var cands = [];
            for (j = 0; j < P.frames.length; j++) {
                var fr = P.frames[j];
                var local = B.id.localBounds(fr, P.page);
                var lw = B.geom.width(local), lh = B.geom.height(local);
                var fArea = lw * lh;
                var ovRatio = (opts.minOverlap === undefined ? 0.25 : opts.minOverlap);
                var minOv = 0.04 * fArea;
                /* how much room does the copy really need? inkBox is the exact
                   extent; for multi-column vertical stories it under-reports the
                   width, so the column count × leading is used as a floor. */
                var ink = null, inkW = 0, inkH = 0, inkArea = 0, cols = 1;
                try { ink = B.id.inkBox(fr); } catch (eInk) { ink = null; }
                if (ink) { inkW = ink.w; inkH = ink.h; }
                /* where the glyphs really are, in page-local points: matching by
                   frame box fails on a lettered document because the copy hangs
                   off the box (`local` is just the container) */
                var inkLocal = null;
                if (ink) {
                    var oInk = B.id.pageOrigin(P.page);
                    inkLocal = B.geom.rect(ink.x1 - oInk.x, ink.y1 - oInk.y, ink.x2 - oInk.x, ink.y2 - oInk.y);
                }
                try { cols = fr.lines.length; } catch (eLn2) { cols = 1; }
                var em = B.id.maxPointSize(fr) || 8;
                if (cols > 1) inkW = Math.max(inkW, cols * em * 1.15);
                inkArea = Math.max(1, inkW * inkH + em * em);
                var list = [];
                for (b = 0; b < bubbles.length; b++) {
                    var bb = bubbles[b];
                    if (minFitInk > 0 && bb.fitInk !== undefined && bb.fitInk < minFitInk) continue;
                    var fit = B.geom.fromArray(bb.fitRect);
                    /* score on the ink box: how much of the COPY sits in the
                       bubble's safe rectangle (TypeR centres the measured ink,
                       so that is also the right thing to match on) */
                    var probe = inkLocal || local;
                    var ov = B.geom.intersectArea(probe, fit);
                    var gap = B.geom.gap(probe, fit);
                    var score = inkArea > 1 ? ov / inkArea : 0;
                    var rank = 0;
                    if (score >= ovRatio) rank = 3;
                    else if (ov >= minOv) rank = 2;
                    /* snapping a frame to a bubble it merely sits NEAR is how
                       parked copy ends up stacked on top of a neighbour: on a
                       lettered document only real overlap counts unless the
                       caller explicitly asks for the snap */
                    else if (gap <= maxDist && opts.snapNear === true) {
                        /* ...and only when the copy is not wildly bigger than
                           the bubble. A page title spanning the top margin is
                           "near" every top bubble; without this size guard it
                           gets pulled into a 40pt speech balloon. */
                        var fw = B.geom.width(fit), fh = B.geom.height(fit);
                        var nw = ink ? inkW : lw, nh = ink ? inkH : lh;
                        var nearScale = opts.nearScale === undefined ? 2.5 : opts.nearScale;
                        if (nw <= fw * nearScale && nh <= fh * nearScale) rank = 2;
                    }
                    if (rank === 0) continue;
                    /* An oversized frame still gets centred: refusing the
                       match because the copy is bigger than the safe box is
                       exactly what leaves finished lettering behind. */
                    list.push({ b: b, rank: rank, ov: ov, score: score, gap: gap, area: B.geom.width(B.geom.fromArray(bb.bbox)) * B.geom.height(B.geom.fromArray(bb.bbox)) });
                }
                list.sort(function (x, y) {
                    if (x.rank !== y.rank) return y.rank - x.rank;
                    if (x.score !== y.score) return y.score - x.score;
                    if (x.ov !== y.ov) return y.ov - x.ov;
                    if (x.gap !== y.gap) return x.gap - y.gap;
                    return x.area - y.area;
                });
                var inkC = null;
                if (inkLocal) inkC = { x: B.geom.cx(inkLocal), y: B.geom.cy(inkLocal) };
                cands.push({ frame: fr, local: local, list: list, inkC: inkC });
            }
            cands.sort(function (x, y) {
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
            var used = {}, picked = {}, claimed = [];
            for (j = 0; j < cands.length; j++) {
                var c = cands[j];
                for (b = 0; b < c.list.length; b++) {
                    var cd = c.list[b];
                    if (used[cd.b]) continue;
                    var dbox = B.geom.fromArray(bubbles[cd.b].fitRect);
                    var clash = false, q;
                    for (q = 0; q < claimed.length; q++) {
                        if (B.geom.intersectArea(claimed[q], dbox) > 0.12 * B.geom.width(dbox) * B.geom.height(dbox)) { clash = true; break; }
                    }
                    if (clash) continue;
                    used[cd.b] = true;
                    claimed.push(dbox);
                    picked[j] = cd;
                    break;
                }
            }
            /* second pass: a big balloon can hold two lettering blocks side by
               side. The first pass may only hand the bubble to one of them;
               re-attach the other when its GLYPHS sit inside the same bubble
               box, so the pair can be translated as one group instead of
               leaving a column behind. */
            for (j = 0; j < cands.length; j++) {
                if (picked[j]) continue;
                var c3 = cands[j];
                if (!c3.inkC) continue;
                for (b = 0; b < c3.list.length; b++) {
                    var cd3 = c3.list[b];
                    if (!used[cd3.b]) continue;
                    var bbox3 = B.geom.fromArray(bubbles[cd3.b].bbox);
                    if (c3.inkC.x >= bbox3.x1 - 2 && c3.inkC.x <= bbox3.x2 + 2 &&
                        c3.inkC.y >= bbox3.y1 - 2 && c3.inkC.y <= bbox3.y2 + 2) {
                        picked[j] = cd3;
                        break;
                    }
                }
            }
            var items = [];
            for (j = 0; j < cands.length; j++) {
                var c2 = cands[j], pk = picked[j], r2 = pk ? bubbles[pk.b] : null;
                items.push({
                    frame: c2.frame, page: P.page, pageNumber: P.pageNumber, local: c2.local,
                    res: r2, b: pk ? pk.b : -1,
                    match: r2 ? (pk.rank === 3 ? 'overlap' : 'near') : 'none',
                    rank: pk ? pk.rank : 0, score: pk ? pk.score : 0,
                    fitInk: r2 ? r2.fitInk : 0,
                    dist: pk ? B.geom.round(pk.gap, 1) : -1
                });
            }
            /* one bubble, several frames: keep their relative arrangement and
               centre the whole group on the bubble (a single target point per
               bubble would stack the two columns on top of each other) */
            var offsetX = opts.offsetX || 0, offsetY = opts.offsetY || 0;
            /* a weak (rank-2) match only grazes the bubble. On an already
               lettered page that is usually a caption or a false-positive
               blob; snapping it can throw copy 30 pt across the art (page 9
               of the sample). Leave it alone unless the shift is small. */
            var weakMax = opts.maxWeakShift === undefined ? 12 : opts.maxWeakShift;
            if (weakMax > 0) {
                for (j = 0; j < items.length; j++) {
                    var wp = picked[j];
                    if (!wp || wp.rank >= 3 || wp.b < 0) continue;
                    var wc = bubbles[wp.b].center, wl = cands[j].local;
                    var wdx = wc[0] + offsetX - (wl.x1 + wl.x2) / 2;
                    var wdy = wc[1] + offsetY - (wl.y1 + wl.y2) / 2;
                    if (Math.sqrt(wdx * wdx + wdy * wdy) > weakMax) {
                        picked[j] = null;
                        items[j].res = null; items[j].b = -1; items[j].match = 'none';
                        items[j].rank = 0; items[j].score = 0; items[j].fitInk = 0;
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
                       centres, NOT the centre of the union box: two columns
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
                    var rc = grp[0].res.center;
                    var dxg = rc[0] + offsetX - gc.x, dyg = rc[1] + offsetY - gc.y;
                    for (j = 0; j < n; j++) {
                        var qq = grp[j].local;
                        grp[j].target = { x: (qq.x1 + qq.x2) / 2 + dxg, y: (qq.y1 + qq.y2) / 2 + dyg };
                        grp[j].groupCount = n;
                    }
                } else {
                    var r1 = grp[0].res.center, l1 = grp[0].local;
                    grp[0].target = { x: r1[0] + offsetX, y: r1[1] + offsetY };
                    grp[0].groupCount = 1;
                }
            }
            groups.push({ page: P.page, pageNumber: P.pageNumber, bubbleCount: bubbles.length, items: items });
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
