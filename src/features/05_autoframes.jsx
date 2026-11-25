/* Feature: 气泡铺框 · Auto Frames
   Surveys the page(s), then creates one empty, centred text frame per speech
   bubble. This is the "one click" half of TypeR: no frame drawn by hand. */

B.feature({
    id: 'autoframes',
    group: '生成',
    title: '气泡铺框 · Auto Frames',
    desc: '扫描当前页（或整个文档）的对话气泡，为每个气泡建一个贴合安全框的空文本框，直接打字即可。',
    order: 2,
    options: [
        { key: 'allPages', label: '全部页', type: 'bool', def: false },
        { key: 'vertical', label: '竖排（直排）', type: 'bool', def: false },
        { key: 'fitToBubble', label: '贴合安全框', type: 'bool', def: true },
        { key: 'inset', label: '内缩%', type: 'number', def: 0 },
        { key: 'autoSize', label: '自动字号', type: 'bool', def: true },
        { key: 'size', label: '字号', type: 'number', def: 24 },
        { key: 'rescan', label: '重新扫描', type: 'bool', def: true }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');
        var S = ctx.settings;

        var pages = ctx.cfg.allPages ? ctx.doc.pages : [B.id.currentPage(ctx.doc)];
        var groups = ctx.ops.bubbleTargets(ctx.doc, pages, S, ctx.cfg.rescan !== false);
        var layers = ctx.ops.layers(ctx.doc, S);

        var made = 0, skipped = 0, items = [], selected = [];
        var proto = null, protoPage = null;

        for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            for (var i = 0; i < grp.bubbles.length; i++) {
                var res = grp.bubbles[i];
                if (!res || !res.ok || !res.fitRect) { skipped++; continue; }

                var box = B.geom.fromArray(res.fitRect);
                if (ctx.cfg.inset) box = B.geom.deflatePct(box, ctx.cfg.inset);
                if (B.geom.width(box) < 10 || B.geom.height(box) < 10) { skipped++; continue; }

                /* start at a size proportional to the balloon so 'fit' has little
                   work to do; TypeR picks the largest size that fits afterwards */
                var size = ctx.cfg.size || S.fontSize;
                if (ctx.cfg.autoSize) {
                    size = B.geom.round(Math.min(48, Math.max(8,
                        Math.min(B.geom.width(box), B.geom.height(box)) * 0.22)), 1);
                }

                var frame;
                if (!proto) {
                    /* the first frame is the template: style it once, every
                       later frame is a duplicate that only gets new bounds */
                    frame = ctx.ops.addFrame(ctx.doc, grp.page, box, layers.text);
                    try { frame.contents = ''; } catch (e) { }
                    B.id.styleText(frame, S.fontFamily, size, S.leading);
                    B.id.justify(frame, true);
                    B.id.setTextOrientation(frame, !!ctx.cfg.vertical);
                    proto = frame;
                    protoPage = grp.page;
                } else {
                    try {
                        frame = proto.duplicate(grp.page);
                        B.id.setLocalBounds(frame, grp.page, box);
                        /* the clone inherits every text setting; only the size
                           is per-bubble, so touch nothing else */
                        try { frame.texts[0].pointSize = size; } catch (eSz) { }
                    } catch (eDup) {
                        B.log.warn('duplicate frame p' + grp.pageNumber + ': ' + eDup.message);
                        frame = ctx.ops.addFrame(ctx.doc, grp.page, box, layers.text);
                        try { frame.contents = ''; } catch (e) { }
                        B.id.styleText(frame, S.fontFamily, size, S.leading);
                        B.id.justify(frame, true);
                        B.id.setTextOrientation(frame, !!ctx.cfg.vertical);
                    }
                }
                selected.push(frame);
                made++;
                items.push({ page: grp.pageNumber, box: B.geom.toArray(box), size: size,
                    vertical: !!ctx.cfg.vertical, clone: proto && frame !== proto && protoPage !== null });
            }
        }

        if (selected.length) {
            /* InDesign refuses one selection spanning several spreads
               ("无法确定此对象的跨页是否打开"). Select the prototype page only;
               the other frames stay on their own pages. */
            var p0 = B.id.pageOf(selected[0]), pick = [];
            for (var s = 0; s < selected.length; s++) {
                try { if (B.id.pageOf(selected[s]) === p0) pick.push(selected[s]); } catch (eSel) { }
            }
            try { app.select(pick); } catch (e2) { B.log.warn('select: ' + e2.message); }
        }

        var pageWord;
        if (groups.length > 1) pageWord = groups.length + ' 页';
        else if (groups.length) pageWord = '第 ' + groups[0].pageNumber + ' 页';
        else pageWord = '-';
        var msg = '已建 ' + made + ' 个文本框' + (skipped ? '，跳过 ' + skipped + ' 个' : '') +
            '（' + pageWord + '）';
        ctx.info(msg);
        return { ok: made > 0, message: msg, items: items, report: { made: made, skipped: skipped, pages: groups.length } };
    }
});
