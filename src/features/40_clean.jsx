/* Feature: 气泡涂白 · Clean
   Paints the bubble body white on its own layer (TypeR's "Clean" layer), so the
   original lettering disappears while the ink outline and the tail stay. */

B.feature({
    id: 'clean',
    group: '气泡',
    title: '气泡涂白 · Clean',
    desc: '按检测到的气泡轮廓生成白色覆盖（去掉原文），保留黑边与尾巴；图形在独立图层。',
    order: 14,
    options: [
        { key: 'allPages', label: '全部页', type: 'bool', def: false },
        { key: 'onlyMatched', label: '只清有框的气泡', type: 'bool', def: true },
        { key: 'removeOld', label: '先删除已有覆盖', type: 'bool', def: true }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');
        var S = ctx.settings;
        var pages = ctx.cfg.allPages ? ctx.doc.pages : [B.id.currentPage(ctx.doc)];
        var layer = B.id.layer(ctx.doc, S.cleanLayer, true);
        if (ctx.cfg.removeOld) B.id.clearLayer(layer);

        var out = [], okCount = 0, seen = {}, pagesSeen = {};

        /* Default: clean only the bubbles that actually hold a text frame.
           Cleaning every detected blob paints the false positives (a white
           cheek reads as a bubble) and leaves white holes in the artwork. */
        if (ctx.cfg.onlyMatched) {
            var frames = [], pi, fi;
            for (pi = 0; pi < pages.length; pi++) {
                var pg = pages[pi];
                try { for (fi = 0; fi < pg.textFrames.length; fi++) frames.push(pg.textFrames[fi]); } catch (eF) { }
            }
            var groups = B.ops.assign(ctx.doc, frames, S, {
                maxDist: 60, minOverlap: 0.12, snapNear: true, onlyText: true,
                offsetY: 0, maxWeakShift: 60, force: true
            });
            for (var gi = 0; gi < groups.length; gi++) {
                var g = groups[gi];
                for (var j = 0; j < g.items.length; j++) {
                    var it = g.items[j];
                    if (!it.res) continue;
                    var key = g.page.id + ':' + it.b;
                    if (seen[key]) continue;
                    seen[key] = true;
                    var shape = B.ops.paintClean(ctx.doc, { res: it.res, page: g.page }, S);
                    if (shape) {
                        okCount++; pagesSeen[g.pageNumber] = true;
                        out.push({ page: g.pageNumber, ok: true, text: '覆盖 ' + it.res.poly.length + ' 点' });
                    } else {
                        out.push({ page: g.pageNumber, ok: false, text: '覆盖失败' });
                    }
                }
            }
        } else {
            var all = ctx.ops.bubbleTargets(ctx.doc, pages, S, true);
            for (var ai = 0; ai < all.length; ai++) {
                var ag = all[ai];
                for (var aj = 0; aj < ag.bubbles.length; aj++) {
                    var res = ag.bubbles[aj];
                    if (!res || !res.ok || !res.poly) continue;
                    var sh = B.ops.paintClean(ctx.doc, { res: res, page: ag.page }, S);
                    if (sh) {
                        okCount++; pagesSeen[ag.pageNumber] = true;
                        out.push({ page: ag.pageNumber, ok: true, text: '覆盖 ' + res.poly.length + ' 点' });
                    }
                }
            }
        }

        var np = 0; for (var k in pagesSeen) if (pagesSeen.hasOwnProperty(k)) np++;
        var msg = okCount + ' 个气泡已清除（' + np + ' 页）';
        ctx.info(msg);
        return { ok: okCount > 0, message: msg, items: out, report: { okCount: okCount, pages: np, layer: layer.name, onlyMatched: !!ctx.cfg.onlyMatched } };
    }
});
