/* Feature: 气泡居中 · Centre in bubble
   TypeR behaviour: the text box's centre lands on the bubble body's centre of
   mass (not the bounding box), with the tail cut off. Optionally the box is
   resized to the safe rectangle and the type is shrunk only as much as needed. */

B.feature({
    id: 'centre',
    group: '气泡',
    title: '居中对齐（EN）',
    desc: '把文本框对齐到气泡重心；可同时套用安全框与最小缩放。',
    order: 10,
    options: [
        { key: 'fitToBubble', label: '套用安全框', type: 'bool', def: true },
        { key: 'forceJustify', label: '强制居中对齐', type: 'bool', def: true },
        { key: 'zeroInset', label: '清除内边距', type: 'bool', def: true },
        { key: 'shrink', label: '自动缩小字号', type: 'bool', def: false },
        { key: 'minPct', label: '最小字号比例', type: 'number', def: 0.75 },
        { key: 'onlyText', label: '只处理有文字的框', type: 'bool', def: true }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');
        /* match the selected frames against the page's DETECTED bubbles;
           the old per-frame Detect() only analysed a crop around each frame
           and produced the strange off-centre results. With no selection,
           fall back to every frame on the current page. */
        var frames = ctx.frames.length ? ctx.frames : (function () {
            var pg = B.id.currentPage(ctx.doc), a = [], i;
            try { for (i = 0; i < pg.textFrames.length; i++) a.push(pg.textFrames[i]); } catch (e) { }
            return a;
        })();
        if (!frames.length) throw new Error('当前页没有文本框');
        if (ctx.cfg.onlyText !== false) {
            var hasText = false;
            for (var ht = 0; ht < frames.length; ht++) {
                try { if (B.id.contents(frames[ht])) { hasText = true; break; } } catch (eT) { }
            }
            if (!hasText) throw new Error('选中的框都是空的；先打字，或关掉「只处理有文字的框」');
        }
        var groups = B.ops.assign(ctx.doc, frames, ctx.settings, {
            maxDist: 60, minOverlap: 0.12, snapNear: true, onlyText: ctx.cfg.onlyText !== false,
            offsetY: 0, maxWeakShift: 60, force: true
        });
        var out = [], okCount = 0, fail = 0;

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var r = B.ops.place(g.items[j], {
                    fitToBubble: ctx.cfg.fitToBubble,
                    forceJustify: ctx.cfg.forceJustify,
                    zeroInset: ctx.cfg.zeroInset,
                    shrink: ctx.cfg.shrink,
                    minPct: ctx.cfg.minPct
                });
                if (r.ok) okCount++; else fail++;
                out.push({
                    page: g.pageNumber,
                    ok: r.ok,
                    text: r.ok
                        ? '→ ' + B.geom.rectText(B.geom.fromArray(r.to), 1) +
                        (r.shrink && r.shrink.iterations ? ' · 字号 ' + r.shrink.from + '→' + r.shrink.to + 'pt' : '')
                        : (r.reason || '未知原因')
                });
            }
        }

        var msg = okCount + ' 个已居中' + (fail ? '，' + fail + ' 个未识别到气泡' : '');
        ctx.info(msg);
        return { ok: okCount > 0, message: msg, items: out, report: { okCount: okCount, fail: fail } };
    }
});
