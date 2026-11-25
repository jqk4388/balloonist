/* Feature: 适配气泡 · Fit
   Same engine as Centre, but pushes the safe box + the smallest possible type
   (TypeR's size ladder: keep the size, shrink only as much as needed). */

B.feature({
    id: 'fit',
    group: '气泡',
    title: '适配气泡 · Fit',
    desc: '文本框铺满气泡安全框；实时检查整体是否超出气泡，字号按气泡大小搜索（默认最小 75%）。',
    order: 12,
    options: [
        { key: 'minPct', label: '最小字号比例', type: 'number', def: 0.75 },
        { key: 'maxPct', label: '最大字号倍数（0=按气泡）', type: 'number', def: 6 },
        { key: 'step', label: '步进 (pt)', type: 'number', def: 0.5 },
        { key: 'forceJustify', label: '强制居中对齐', type: 'bool', def: true },
        { key: 'zeroInset', label: '清除内边距', type: 'bool', def: true },
        { key: 'onlyText', label: '只处理有文字的框', type: 'bool', def: true }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');
        /* use the detected bubble bodies (same matcher as 一键对齐), not a
           per-frame crop of the page PNG */
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
        var out = [], okCount = 0, fail = 0, overflow = 0;

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var r = B.ops.place(g.items[j], {
                    fitToBubble: true,
                    forceJustify: ctx.cfg.forceJustify,
                    zeroInset: ctx.cfg.zeroInset,
                    fitSize: true,
                    minPct: ctx.cfg.minPct,
                    maxPct: ctx.cfg.maxPct,
                    step: ctx.cfg.step
                });
                if (r.ok) okCount++;
                else { fail++; if (r.shrink && r.shrink.overflow) overflow++; }
                out.push({
                    page: g.pageNumber,
                    ok: r.ok,
                    text: r.ok
                        ? '字号 ' + (r.shrink ? r.shrink.from + '→' + r.shrink.to + 'pt (' + r.shrink.iterations + ' 步)' : '未变')
                        : (r.reason || '未知原因')
                });
            }
        }

        var msg = okCount + ' 个已适配' + (fail ? '，' + fail + ' 个失败（' + overflow + ' 个缩到最小仍溢出）' : '');
        ctx.info(msg);
        return { ok: okCount > 0, message: msg, items: out, report: { okCount: okCount, fail: fail, overflow: overflow } };
    }
});
