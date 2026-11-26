/* Feature: 一键对齐 · Align All
   The one-click pass for an already-lettered document: every text frame on the
   current page (or the whole document) is matched to its bubble — containment
   in the bubble body first, then bounding box, then nearest within maxDist —
   and moved onto that bubble's centre of mass, justified, and optionally
   fitted to the safe rectangle. */

B.feature({
    id: 'alignAll',
    group: '气泡',
    title: '气泡居中',
    desc: '全页所有文本框各自贴到重叠或附近的气泡并居中（按已导入的文字直接跑，可先试算不移动）。',
    order: 11,
    options: [
        { key: 'allPages', label: '全部页', type: 'bool', def: true },
        { key: 'onlyText', label: '只处理有字的框', type: 'bool', def: true },
        { key: 'skipLayer', label: '跳过图层名', type: 'text', def: 'SFX' },
        { key: 'moveOnly', label: '只移动（不动文字属性）', type: 'bool', def: true },
        { key: 'byInk', label: '按墨迹中心对齐（实验）', type: 'bool', def: false },
        { key: 'resizeToBox', label: '顺带套用安全框尺寸', type: 'bool', def: false },
        { key: 'fitSize', label: '溢出时缩字号', type: 'bool', def: false },
        { key: 'snapNear', label: '允许就近吸附', type: 'bool', def: true },
        { key: 'maxDist', label: '吸附距离 (pt)', type: 'number', def: 48 },
        { key: 'minOverlap', label: '墨迹覆盖比下限', type: 'number', def: 0.25 },
        { key: 'autoShift', label: '自动补偿整批偏移', type: 'bool', def: true },
        { key: 'shiftX', label: '手动左右偏移 (pt, +右)', type: 'number', def: 0 },
        { key: 'shiftY', label: '手动上下偏移 (pt, +下)', type: 'number', def: 0 },
        { key: 'bubblePad', label: '气泡描边容差 (pt, -1=自动)', type: 'number', def: -1 },
        { key: 'offsetY', label: '目标点下移 (pt)', type: 'number', def: 2 },
        { key: 'maxWeakShift', label: '弱匹配最大移动 (pt)', type: 'number', def: 60 },
        { key: 'detect', label: '检测器 (blobs/auto)', type: 'text', def: 'blobs' },
        { key: 'lightThr', label: '亮区阈值 (0-255)', type: 'number', def: 205 },
        { key: 'minFill', label: '填充率下限', type: 'number', def: 0.5 },
        { key: 'dpi', label: '分析 dpi (0=用配置)', type: 'number', def: 150 },
        { key: 'dryRun', label: '试算不移动', type: 'bool', def: false },
        { key: 'minPct', label: '最小字号比例', type: 'number', def: 0.75 },
        { key: 'maxPct', label: '最大字号比例', type: 'number', def: 2 }
    ],
    run: function (ctx) {
        if (!ctx.doc) throw new Error('没有打开的文档');

        var over = { detect: ctx.cfg.detect, lightThr: ctx.cfg.lightThr, minFill: ctx.cfg.minFill };
        if (ctx.cfg.dpi > 0) over.dpi = ctx.cfg.dpi;
        var settings = B.ops.withSettings(over);
        var frames;
        if (ctx.cfg.allPages) frames = B.id.docFrames(ctx.doc);
        else if (ctx.frames.length) frames = ctx.frames;
        else {
            var pg = B.id.currentPage(ctx.doc);
            frames = [];
            try {
                for (var q = 0; q < pg.textFrames.length; q++) frames.push(pg.textFrames[q]);
            } catch (ePg) { }
        }
        if (!frames.length) throw new Error('没有文本框');

        ctx.info('扫描 ' + frames.length + ' 个文本框');
        var groups = B.ops.assign(ctx.doc, frames, settings, {
            maxDist: ctx.cfg.maxDist,
            minOverlap: ctx.cfg.minOverlap,
            snapNear: ctx.cfg.snapNear,
            onlyText: ctx.cfg.onlyText,
            skipLayer: ctx.cfg.skipLayer,
            autoShift: ctx.cfg.autoShift === true,
            shiftX: ctx.cfg.shiftX || 0,
            shiftY: ctx.cfg.shiftY || 0,
            bubblePad: ctx.cfg.bubblePad === undefined ? -1 : ctx.cfg.bubblePad,
            offsetY: ctx.cfg.offsetY,
            maxWeakShift: ctx.cfg.maxWeakShift,
            force: true
        });

        var matched = 0, inside = 0, near = 0, failed = 0, placed = 0, moved = 0;
        var out = [];
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var it = g.items[j];
                if (!it.res) {
                    matched++;
                    failed++;
                    out.push({ page: g.pageNumber, ok: false, text: '第' + g.pageNumber + '页 未匹配到气泡: ' + B.geom.rectText(it.local, 0) });
                    continue;
                }
                matched++;
                if (it.match === 'overlap') inside++; else near++;

                if (ctx.cfg.dryRun) {
                    out.push({
                        page: g.pageNumber, ok: true,
                        text: '第' + g.pageNumber + '页 ' + B.geom.rectText(it.local, 0) + ' → ' +
                            it.match + (it.groupCount > 1 ? ' · 同气泡成组(' + it.groupCount + ')' : '') +
                            ' (d=' + it.dist + ') 目标 ' +
                            (it.target ? (B.geom.round(it.target.x, 1) + ',' + B.geom.round(it.target.y, 1))
                                       : B.geom.rectText(B.geom.fromArray(it.res.fitRect), 1))
                    });
                    continue;
                }

                var moveOnly = ctx.cfg.moveOnly !== false;
                var r = B.ops.place(it, {
                    moveOnly: moveOnly,
                    byInk: ctx.cfg.byInk === true,
                    resizeToBox: !!ctx.cfg.resizeToBox,
                    fitToBubble: !!ctx.cfg.resizeToBox,
                    /* a finished lettering job keeps its size and attributes:
                       no refit unless the user explicitly asked for one */
                    fitSize: false,
                    shrink: false,
                    forceJustify: !moveOnly,
                    zeroInset: true,
                    minPct: ctx.cfg.minPct,
                    maxPct: ctx.cfg.maxPct,
                    step: 0.5
                });
                if (r.ok) placed++; else failed++;
                if (r.ok && r.to && B.geom.rectText(B.geom.fromArray(r.to), 1) !== B.geom.rectText(it.local, 1)) moved++;
                out.push({
                    page: g.pageNumber, ok: r.ok,
                    text: r.ok
                        ? '第' + g.pageNumber + '页 ' + it.match + ' → ' + B.geom.rectText(B.geom.fromArray(r.to), 1) +
                          (r.moved === false ? '' : (r.viaInk ? ' · 墨迹对齐' : '')) +
                          (r.shrink && r.shrink.iterations ? ' · 字号 ' + r.shrink.from + '→' + r.shrink.to + 'pt' : '')
                        : '第' + g.pageNumber + '页 ' + (r.reason || '失败')
                });
            }
            if (ctx.cfg.dryRun) {
                var sh = g.shift || { x: 0, y: 0, mode: 'none' };
                ctx.info('第' + g.pageNumber + '页：' + g.bubbleCount + ' 个气泡，' + g.items.length + ' 个框' +
                    (sh.mode !== 'none' ? '，匹配前补偿 ' + sh.x + ',' + sh.y + 'pt（' + sh.mode + '）' : ''));
            }
        }

        var msg;
        if (ctx.cfg.dryRun) {
            msg = '试算：' + groups.length + ' 页 / ' + matched + ' 个框，命中 ' + inside + ' 个在气泡内 + ' + near +
                ' 个吸附，未匹配 ' + failed + '（未移动任何东西）';
        } else {
            msg = '已对齐 ' + placed + ' 个文本框（' + groups.length + ' 页）' +
                (ctx.cfg.moveOnly !== false ? '，只移动未改文字属性' : '') + '，未匹配/失败 ' + failed;
        }
        ctx.info(msg);
        return {
            ok: placed > 0 || ctx.cfg.dryRun,
            message: msg,
            items: out,
            report: { pages: groups.length, frames: frames.length, inside: inside, near: near, placed: placed, failed: failed, moved: moved }
        };
    }
});
