/* Feature: 气泡检测 · Inspect
   Draws what the analyser sees: bubble outline, centre of mass, safe box.
   No text is touched — this is the "why did it move there?" diagnostic. */

B.feature({
    id: 'inspect',
    group: '诊断',
    title: '检测气泡 · Inspect',
    desc: '直接导出页面 PNG 检测气泡，不需要选中文本框；画出轮廓、重心与安全框。',
    order: 1,
    options: [
        { key: 'allPages', label: '全部页', type: 'bool', def: true },
        { key: 'drawPoly', label: '轮廓', type: 'bool', def: true },
        { key: 'drawBox', label: '安全框', type: 'bool', def: true },
        { key: 'drawCentre', label: '重心', type: 'bool', def: true },
        { key: 'clear', label: '先清空', type: 'bool', def: true }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');
        var S = ctx.settings;
        var layer = B.id.layerTop(ctx.doc, S.debugLayer);
        if (ctx.cfg.clear) B.id.clearLayer(layer);

        var red = B.id.rgbColor(ctx.doc, 'Balloonist Debug Red', S.debugStrokeRGB || [255, 0, 0]);
        var blue = B.id.rgbColor(ctx.doc, 'Balloonist Debug Blue', [0, 90, 255]);
        var none = B.id.noneSwatch(ctx.doc);

        /* whole-page PNG + blob analysis; a text frame is not required */
        var pages = ctx.cfg.allPages ? ctx.doc.pages : [B.id.currentPage(ctx.doc)];
        var groups = B.ops.bubbleTargets(ctx.doc, pages, S, true);
        var items = [], drawn = 0, bubbles = 0;

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            for (var j = 0; j < g.bubbles.length; j++) {
                var res = g.bubbles[j];
                bubbles++;
                items.push({ page: g.pageNumber, ok: !!(res && res.ok), text: B.ops.describe(res) });
                if (!res || !res.ok) continue;

                if (ctx.cfg.drawPoly && res.poly && res.poly.length > 2) {
                    if (B.id.addPolygon(layer, B.id.localPath(res.poly, g.page), red, none, 1.5, g.page)) drawn++;
                }
                if (ctx.cfg.drawBox && res.fitRect) {
                    var box = B.geom.fromArray(res.fitRect);
                    var o = B.id.pageOrigin(g.page);
                    B.id.addRect(layer, B.geom.rect(box.x1 + o.x, box.y1 + o.y, box.x2 + o.x, box.y2 + o.y), blue, none, 1, g.page);
                    drawn++;
                }
                if (ctx.cfg.drawCentre && res.center) {
                    var p = B.id.localPoint(res.center, g.page);
                    var arm = 10;
                    B.id.addLine(layer, p[0] - arm, p[1], p[0] + arm, p[1], red, 1.2, g.page);
                    B.id.addLine(layer, p[0], p[1] - arm, p[0], p[1] + arm, red, 1.2, g.page);
                    drawn += 2;
                }
            }
            ctx.info('第' + g.pageNumber + '页：' + g.bubbles.length + ' 个气泡');
        }

        var msg = drawn + ' 个调试图形，' + bubbles + ' 个气泡（' + groups.length + ' 页）';
        ctx.info(msg);
        return {
            ok: bubbles > 0, message: msg, items: items,
            report: { pages: groups.length, bubbles: bubbles, drawn: drawn, layer: layer.name }
        };
    }
});
