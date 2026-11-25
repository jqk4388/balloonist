/* ==========================================================================
   Balloonist · InDesign DOM layer
   Every raw InDesign call lives here so features stay declarative.
   ========================================================================== */

B.id = (function () {

    function two(n) { return (n < 10 ? '0' : '') + n; }

    var api = {

        app: function () { return app; },

        doc: function () {
            if (!app.documents.length) return null;
            return app.activeDocument;
        },

        /* the page the user is looking at: layout window page, else page 1 */
        currentPage: function (doc) {
            doc = doc || B.id.doc();
            if (!doc) return null;
            try {
                var win = app.activeWindow;
                if (win && win instanceof LayoutWindow && win.activePage) return win.activePage;
            } catch (e) { }
            try {
                var sel = app.selection, p = B.id.pageOf(sel && sel.length ? sel[0] : null);
                if (p) return p;
            } catch (e2) { }
            return doc.pages[0];
        },

        /* ---------- swatches / layers ---------- */

        swatch: function (doc, name) {
            try {
                var s = doc.swatches.itemByName(name);
                if (s && s.isValid) return s;
            } catch (e) { }
            return null;
        },

        processColor: function (doc, name, cmyk) {
            try {
                var existing = doc.colors.itemByName(name);
                if (existing && existing.isValid) {
                    try { existing.colorValue = cmyk; } catch (eUp) { }
                    return existing;
                }
            } catch (e) { }
            try {
                return doc.colors.add({
                    name: name,
                    model: ColorModel.PROCESS,
                    space: ColorSpace.CMYK,
                    colorValue: cmyk
                });
            } catch (e2) {
                B.log.warn('processColor(' + name + '): ' + e2.message);
                return doc.swatch(doc, 'Black');
            }
        },

        rgbColor: function (doc, name, rgb) {
            try {
                var existing = doc.colors.itemByName(name);
                if (existing && existing.isValid) {
                    existing.colorValue = rgb;
                    return existing;
                }
            } catch (e) { }
            try {
                return doc.colors.add({
                    name: name,
                    model: ColorModel.PROCESS,
                    space: ColorSpace.RGB,
                    colorValue: rgb
                });
            } catch (e2) {
                B.log.warn('rgbColor(' + name + '): ' + e2.message);
                return B.id.swatch(doc, 'Black');
            }
        },

        layer: function (doc, name, makeBelow) {
            var L = null;
            try {
                L = doc.layers.itemByName(name);
                if (L && !L.isValid) L = null;
            } catch (e) { L = null; }
            if (!L) {
                try {
                    L = doc.layers.add({ name: name });
                } catch (e2) {
                    L = doc.layers.itemByName(name);
                }
            }
            if (L && makeBelow && doc.layers.length > 1) {
                try {
                    var last = doc.layers[doc.layers.length - 1];
                    if (L.index < last.index) L.move(LocationOptions.AFTER, last);
                } catch (e3) { B.log.warn('layer move: ' + e3.message); }
            }
            return L;
        },

        /* layer at the very top of the stack (new layers land there by default) */
        layerTop: function (doc, name) {
            var L = B.id.layer(doc, name, false);
            try {
                if (L && doc.layers.length && doc.layers[0].id !== L.id) L.move(LocationOptions.BEFORE, doc.layers[0]);
            } catch (e) { B.log.warn('layerTop: ' + e.message); }
            return L;
        },

        /* layer directly *under* another one (used for the white clean covers) */
        layerUnder: function (doc, name, above) {
            var L = B.id.layer(doc, name, false);
            try {
                if (L && above && L.id !== above.id) L.move(LocationOptions.AFTER, above);
            } catch (e) { B.log.warn('layerUnder: ' + e.message); }
            return L;
        },

        clearLayer: function (layer) {
            var removed = 0;
            if (!layer) return 0;
            /* guard: a Document also exposes pageItems — never wipe a whole doc */
            try { if (layer.layers) { B.log.warn('clearLayer: given a document, ignored'); return 0; } } catch (eDoc) { }
            for (var i = layer.pageItems.length - 1; i >= 0; i--) {
                try { layer.pageItems[i].remove(); removed++; } catch (e) { }
            }
            return removed;
        },

        removeLayer: function (doc, name) {
            try {
                var L = doc.layers.itemByName(name);
                if (L && L.isValid) { L.remove(); return true; }
            } catch (e) { B.log.warn('removeLayer: ' + e.message); }
            return false;
        },

        /* ---------- pages & coordinates ---------- */

        pageOf: function (item) {
            var node = item, guard = 0;
            while (node && guard++ < 10) {
                try {
                    if (node instanceof Page) return node;
                } catch (e) { }
                try {
                    var p = node.parentPage;
                    if (p && p.isValid) return p;
                } catch (e2) { }
                try { node = node.parent; } catch (e3) { return null; }
            }
            return null;
        },

        /* Page.documentOffset and Page.pageNumber DO NOT EXIST in InDesign 2025
           (both throw). The old code therefore produced page 0 and the PNG
           export answered "导出的页码设置无效". The page label is the reliable
           identity: pageString accepts it, and the export file names are
           built from it. */
        pageLabel: function (page) {
            try { if (page && page.name) return String(page.name); } catch (e) { }
            return '1';
        },

        pageNumber: function (page) {
            try {
                var n = parseInt(B.id.pageLabel(page), 10);
                if (!isNaN(n) && n > 0) return n;
            } catch (e1) { }
            try {
                var pages = page.parent.pages, i;
                for (i = 0; i < pages.length; i++) if (pages[i].id === page.id) return i + 1;
            } catch (e2) { }
            return 1;
        },

        /* The page's top-left corner in item space. page.bounds is not always
           that corner (two-up spreads, RTL layout, pages laid out by index):
           the page-covering artwork is, once its bleed is taken off. */
        pageOrigin: function (page) {
            var cache = B.id._origins || (B.id._origins = {});
            var key = 'p' + page.id;
            if (cache[key]) return cache[key];
            var origin = { x: 0, y: 0 };
            try {
                var b = page.bounds, pw = b[3] - b[1], ph = b[2] - b[0];
                /* InDesign returns page-item geometricBounds in PAGE-TRIM
                   coordinates on this document (page 2 starts at x=362.83 in
                   the spread, yet its copy sits at x=81). Trusting the old
                   bleed-centred artwork origin shifted every frame by ±4.252
                   and made `setLocalBounds` move it twice as far. Only when
                   the page's own text frames clearly live in spread
                   coordinates do we offset by the trim corner. */
                var fr = null;
                try { fr = page.textFrames; } catch (eFr) { fr = null; }
                if (fr && fr.length) {
                    var absolute = false, i;
                    for (i = 0; i < fr.length; i++) {
                        var gb = null;
                        try { gb = fr[i].geometricBounds; } catch (eGb) { gb = null; }
                        if (!gb) continue;
                        if (gb[3] > pw + 10 || gb[1] < -10) { absolute = true; break; }
                    }
                    if (absolute) origin = { x: b[1], y: b[0] };
                }
            } catch (e) { }
            origin.x = B.geom.round(origin.x, 3);
            origin.y = B.geom.round(origin.y, 3);
            cache[key] = origin;
            return origin;
        },

        localBounds: function (item, page) {
            var b = item.geometricBounds, o = B.id.pageOrigin(page);
            return B.geom.rect(b[1] - o.x, b[0] - o.y, b[3] - o.x, b[2] - o.y);
        },

        setLocalBounds: function (item, page, r) {
            var o = B.id.pageOrigin(page);
            item.geometricBounds = [r.y1 + o.y, r.x1 + o.x, r.y2 + o.y, r.x2 + o.x];
        },

        localPoint: function (pt, page) {
            var o = B.id.pageOrigin(page);
            return [pt[0] + o.x, pt[1] + o.y];
        },

        localPath: function (poly, page) {
            var out = [], o = B.id.pageOrigin(page), i;
            for (i = 0; i < poly.length; i++) out.push([poly[i][0] + o.x, poly[i][1] + o.y]);
            return out;
        },

        /* ---------- selection ---------- */

        frames: function () {
            var out = [];
            var sel = app.selection;
            if (!sel || sel.length === 0) return out;
            B.id.collectFrames(sel, out, 0);
            return out;
        },

        collectFrames: function (items, out, depth) {
            if (depth > 6) return;
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                try {
                    if (it instanceof TextFrame) { out.push(it); continue; }
                } catch (e) { }
                try {
                    if (it instanceof Group) {
                        B.id.collectFrames(it.allPageItems, out, depth + 1);
                        continue;
                    }
                } catch (e2) { }
                try {
                    if (it instanceof Text) {
                        var tf = it.parentTextFrames[0];
                        if (tf) out.push(tf);
                        continue;
                    }
                } catch (e3) { }
                try {
                    if (it instanceof Story) {
                        for (var k = 0; k < it.textContainers.length; k++) out.push(it.textContainers[k]);
                        continue;
                    }
                } catch (e4) { }
                try {
                    if (it instanceof Application || it instanceof Document || it instanceof Page) continue;
                } catch (e5) { }
            }
            return out;
        },

        docFrames: function (doc) {
            var out = [];
            try {
                for (var i = 0; i < doc.textFrames.length; i++) out.push(doc.textFrames[i]);
            } catch (e) { }
            return out;
        },

        /* ---------- text ---------- */

        textOf: function (frame) {
            try { return frame.texts[0]; } catch (e) { return null; }
        },

        /* The frame's own texts[0] only exposes the composed part of the story;
           overset copy lives in parentStory. Always measure and restyle the
           story, otherwise the tail of long copy silently keeps old sizes. */
        story: function (frame) {
            try { return frame.parentStory; } catch (e) { }
            try { return frame.texts[0]; } catch (e2) { return null; }
        },

        contents: function (frame) {
            var st = B.id.story(frame);
            if (st) { try { return st.contents; } catch (e) { } }
            try { return frame.contents; } catch (e2) { return ''; }
        },

        setContents: function (frame, txt) {
            try { frame.contents = txt; return true; } catch (e) { B.log.warn('setContents: ' + e.message); return false; }
        },

        justify: function (frame, zeroInset) {
            var ok = 0;
            try {
                frame.paragraphs.everyItem().justification = Justification.CENTER_ALIGN; ok++;
            } catch (e) { if (frame.paragraphs.length) frame.paragraphs[0].justification = Justification.CENTER_ALIGN; }
            try {
                frame.textFramePreferences.verticalJustification = VerticalJustification.CENTER_ALIGN; ok++;
            } catch (e2) { B.log.warn('vertical justification: ' + e2.message); }
            if (zeroInset) {
                try { frame.textFramePreferences.insetSpacing = [0, 0, 0, 0]; ok++; } catch (e3) { }
            }
            /* Do NOT touch firstBaselineOffset here. InDesign's default is
               EMOBX_HEIGHT (全角字框高度); forcing CAP_HEIGHT (字母上缘) changes
               the design of every frame the plugin touches. */
            return ok;
        },

        /* Horizontal vs vertical (直排) story layout.  InDesign exposes this
           on the parent story's StoryPreference, not on CharacterDirection
           (which only has LTR/RTL).  Japanese/Chinese vertical copy runs
           right-to-left, so the column order must be set together with the
           orientation. */
        setTextOrientation: function (frame, vertical) {
            var sp = null;
            try { sp = frame.parentStory.storyPreferences; } catch (e0) { }
            if (!sp) return false;
            try { sp.storyOrientation = vertical ? StoryHorizontalOrVertical.VERTICAL
                                                 : StoryHorizontalOrVertical.HORIZONTAL; } catch (e1) { B.log.warn('orientation: ' + e1.message); return false; }
            try { sp.storyDirection = vertical ? StoryDirectionOptions.RIGHT_TO_LEFT_DIRECTION
                                               : StoryDirectionOptions.LEFT_TO_RIGHT_DIRECTION; } catch (e2) { B.log.warn('storyDirection: ' + e2.message); }
            try { frame.recompose(); } catch (e3) { }
            return true;
        },

        /* point size of a frame: max over story characters (authoritative) */
        maxPointSize: function (frame) {
            var mx = 0, i, n = 0;
            var st = B.id.story(frame);
            try {
                var chars = st.characters;
                n = chars.length;
                for (i = 0; i < n && i < 2000; i++) {
                    var s = chars[i].pointSize;
                    if (s > mx) mx = s;
                }
            } catch (e) { }
            if (mx === 0) {
                try { mx = st.paragraphs[0].pointSize; } catch (e2) {
                    try { mx = frame.paragraphs[0].pointSize; } catch (e3) { mx = 12; }
                }
            }
            return mx;
        },

        charSizes: function (frame) {
            var sizes = [], i;
            var st = B.id.story(frame);
            try {
                var chars = st.characters;
                for (i = 0; i < chars.length && i < 2000; i++) sizes.push(chars[i].pointSize);
            } catch (e) { }
            return sizes;
        },

        /* proportional resize of every character (uniform fast path first) */
        applyScale: function (frame, sizes, factor) {
            var st = B.id.story(frame);
            if (!st) return;
            var first = sizes.length ? sizes[0] : 0, same = true, i;
            for (i = 1; i < sizes.length; i++) if (Math.abs(sizes[i] - first) > 0.001) { same = false; break; }
            if (same && sizes.length) {
                try {
                    st.characters.everyItem().pointSize = B.geom.round(first * factor, 3);
                } catch (e0) {
                    try { st.paragraphs.everyItem().pointSize = B.geom.round(first * factor, 3); } catch (e1) { }
                }
            } else {
                try {
                    var chars = st.characters;
                    for (i = 0; i < sizes.length && i < chars.length; i++) {
                        chars[i].pointSize = B.geom.round(sizes[i] * factor, 3);
                    }
                } catch (e2) { B.log.warn('applyScale: ' + e2.message); }
            }
            try { frame.recompose(); } catch (e3) { }
        },

        /* authoritative fit test. frame.overflows alone is unreliable right
           after a pointSize change (it can stay true after the type has been
           recomposed small enough), so cross-check the composed line count:
           when every story line sits inside the frame, the copy fits. */
        fits: function (frame) {
            var over = false;
            try { frame.recompose(); over = frame.overflows; } catch (e) { over = false; }
            if (!over) return true;
            try {
                var sl = B.id.story(frame).lines.length;
                var fl = frame.lines.length;
                if (fl >= sl) return true;
            } catch (e2) { }
            return false;
        },

        /* shrink until the text stops overflowing the frame; keeps relative sizes */
        shrinkToFit: function (frame, minPct, step) {
            var sizes = B.id.charSizes(frame);
            if (sizes.length === 0) return { from: 0, to: 0, iterations: 0, overflow: false };
            var mx = 0, i;
            for (i = 0; i < sizes.length; i++) if (sizes[i] > mx) mx = sizes[i];
            var floor = mx * Math.max(0.05, minPct === undefined ? 0.75 : minPct);
            var stepSize = step || 0.5;
            if (B.id.fits(frame)) return { from: mx, to: mx, iterations: 0, overflow: false };

            var it = 0, cur = mx, done = false;
            while (!done && cur > floor) {
                it++;
                cur -= stepSize;
                if (cur < floor) cur = floor;
                B.id.applyScale(frame, sizes, cur / mx);
                done = B.id.fits(frame);
            }
            if (!done) B.id.applyScale(frame, sizes, floor / mx);
            return { from: mx, to: B.geom.round(done ? cur : floor, 2), iterations: it, overflow: !done };
        },

        /* grow the type until it just fills the frame (TypeR's "largest that
           fits" rung) — used when the copy is smaller than the balloon allows */
        growToFit: function (frame, maxPct, step) {
            var sizes = B.id.charSizes(frame);
            if (sizes.length === 0) return { from: 0, to: 0, iterations: 0, overflow: false };
            var mx = 0, i;
            for (i = 0; i < sizes.length; i++) if (sizes[i] > mx) mx = sizes[i];
            var ceiling = mx * (maxPct === undefined ? 2 : maxPct);
            var stepSize = step || 0.5;
            if (!B.id.fits(frame)) return { from: mx, to: mx, iterations: 0, overflow: true };

            var it = 0, cur = mx, last = mx, done = false;
            while (!done && cur + stepSize <= ceiling && it < 500) {
                it++;
                cur += stepSize;
                B.id.applyScale(frame, sizes, cur / mx);
                if (B.id.fits(frame)) last = cur; else done = true;
            }
            /* restore the largest size that really fit and verify it again */
            var guard = 0;
            while (guard < 40) {
                guard++;
                B.id.applyScale(frame, sizes, last / mx);
                if (B.id.fits(frame)) break;
                if (last - stepSize < mx) break;
                last -= stepSize;
            }
            return { from: mx, to: B.geom.round(last, 2), iterations: it + guard, overflow: !B.id.fits(frame) };
        },

        /* one ladder for both directions: shrink if it overflows, else grow */
        fitText: function (frame, minPct, maxPct, step) {
            if (!B.id.fits(frame)) return B.id.shrinkToFit(frame, minPct, step);
            return B.id.growToFit(frame, maxPct, step);
        },

        /* Geometry-based fit, for stories whose orientation makes InDesign's
           `overflows` flag lie: vertical CJK copy in a tall narrow box reports
           no overflow while its ink spills over the bubble. Capacity is
           estimated from the box and the character advance:
             rows = floor(boxH / advance), cols = floor(boxW / advance)
           and the size walks down until every paragraph fits that grid.
           advance = pointSize * 1.02 because a CJK glyph is square. */
        fitToBox: function (frame, minPct, step) {
            var story = B.id.story(frame);
            var text = story.contents;
            if (!text) return { from: 0, to: 0, iterations: 0, overflow: false, mode: 'box' };

            var b = frame.geometricBounds;
            var boxW = Math.abs(b[3] - b[1]), boxH = Math.abs(b[2] - b[0]);
            var maxSize = B.id.maxPointSize(frame);
            if (!maxSize) return { from: 0, to: 0, iterations: 0, overflow: false, mode: 'box' };
            var floorSize = maxSize * (minPct === undefined ? 0.75 : minPct);
            /* vertical CJK leading is typically 0.8-0.95 of the size, so
               the usable advance is a bit under the em */
            var advance = 0.95;

            /* a paragraph break does not force a column break in vertical
               CJK layout, so capacity is the whole story against the grid */
            var need = 0, i;
            var paras = story.paragraphs;
            for (i = 0; i < paras.length; i++) {
                var pt = paras[i].contents.replace(/\r/g, '').length;
                if (pt > need) need = pt;
            }
            var total = text.replace(/\r/g, '').length;

            var size = maxSize, it = 0, rows = 0, cols = 0;
            while (it < 400) {
                var adv = size * advance;
                rows = Math.max(1, Math.floor(boxH / adv));
                cols = Math.max(1, Math.floor(boxW / adv));
                if (rows * cols >= total) break;
                if (size - (step || 0.5) < floorSize) break;
                size -= (step || 0.5);
                it++;
            }

            if (size < maxSize) B.id.applyScale(frame, B.id.charSizes(frame), size / maxSize);

            var adv2 = size * advance;
            var rows2 = Math.max(1, Math.floor(boxH / adv2));
            var cols2 = Math.max(1, Math.floor(boxW / adv2));
            return {
                from: B.geom.round(maxSize, 2), to: B.geom.round(size, 2),
                iterations: it, mode: 'box',
                overflow: !(rows2 * cols2 >= total)
            };
        },
        /* Exact ink extent from per-character geometry. InDesign exposes
           character.baseline (the coordinate the glyph sits on) and
           character.horizontalOffset (its column), plus ascent/descent, which
           is enough to measure how far the copy actually reaches — the only
           reliable way to know whether copy spills out of a bubble, because
           the frame's `overflows` flag stays false for vertical CJK stories
           that already hang outside their box. Returns item-space points. */
        inkBox: function (frame) {
            var story = B.id.story(frame);
            var chars = story.characters;
            var n = chars.length;
            if (!n) return null;
            var step = n > 300 ? Math.ceil(n / 300) : 1;
            var bmin = 1e9, bmax = -1e9, hmin = 1e9, hmax = -1e9, asc = 0, size = 0, i;
            for (i = 0; i < n; i += step) {
                var ch = chars[i];
                try {
                    var b = ch.baseline, h = ch.horizontalOffset;
                    if (b < bmin) bmin = b;
                    if (b > bmax) bmax = b;
                    if (h < hmin) hmin = h;
                    if (h > hmax) hmax = h;
                    var a = ch.ascent || 0, ps = ch.pointSize || 0;
                    if (a > asc) asc = a;
                    if (ps > size) size = ps;
                } catch (e) { }
            }
            if (bmin > bmax || hmin > hmax) return null;
            /* a CJK glyph is square: the last one adds a full em in both axes */
            var w = (hmax - hmin) + (size || asc * 2);
            var hh = (bmax - bmin) + (size || asc * 2);
            return { x1: hmin - asc, y1: bmin - asc, x2: hmin - asc + w, y2: bmin - asc + hh, w: w, h: hh };
        },

        /* shrink the story until the measured ink fits inside `box`
           (item space). factor is applied to every character. */
        fitInkToBox: function (frame, box, minPct, passes) {
            var ink = B.id.inkBox(frame);
            if (!ink) return { from: 0, to: 0, iterations: 0, overflow: false };
            var mx = B.id.maxPointSize(frame);
            var floorSize = mx * (minPct === undefined ? 0.7 : minPct);
            var factor = 1, it = 0, tries = passes || 6;
            var boxW = B.geom.width(box), boxH = B.geom.height(box);

            while (it < tries) {
                var need = Math.min(boxW / ink.w, boxH / ink.h);
                if (need >= 0.999) break;
                factor = Math.max(factor * need * 0.985, floorSize / mx);
                B.id.applyScale(frame, B.id.charSizes(frame), factor);
                ink = B.id.inkBox(frame);
                if (!ink) break;
                it++;
                if (factor <= floorSize / mx + 0.0001) break;
            }
            var still = B.id.inkBox(frame);
            return {
                from: B.geom.round(mx, 2), to: B.geom.round(mx * factor, 2), iterations: it,
                overflow: !!(still && (still.w > boxW + 0.5 || still.h > boxH + 0.5))
            };
        },

        /* Fit the copy into the bubble's safe rectangle, measured on the
           FRAME and on the real ink - not on InDesign's `overflows` flag,
           which is computed against a frame that keeps growing.

           Two traps this has to defeat:
           1. textFramePreferences.autoSizingType is ON in the lettering files
              (1752069993); setting geometricBounds while it is on is
              immediately undone by InDesign and the frame grows downwards.
              Turn it off and set the box again on every trial.
           2. A 19 pt trial can leave the frame exactly at the safe rect but
              still report overflows=true / composition outside the box,
              while a smaller size fits. Require both `fits()` and the measured
              ink inside the box, then binary-search the largest size.

           `maxPct` is the optional ceiling relative to the current size;
           0/undefined means "let the bubble decide" (with a 6x sanity cap).
           Baseline offset is never touched. */
        fitFrameToBubble: function (frame, page, box, minPct, maxPct, step) {
            var sizes = B.id.charSizes(frame);
            if (!sizes.length) return { from: 0, to: 0, iterations: 0, overflow: false, mode: 'bubble' };
            var mx = 0, i;
            for (i = 0; i < sizes.length; i++) if (sizes[i] > mx) mx = sizes[i];
            var floorSize = mx * Math.max(0.05, minPct === undefined ? 0.75 : minPct);
            var ceiling = (maxPct && maxPct > 0) ? mx * maxPct : mx * 20;
            if (ceiling < mx) ceiling = mx;
            var boxW = B.geom.width(box), boxH = B.geom.height(box);
            var it = 0;

            /* auto-sizing would override every box we set */
            try { frame.textFramePreferences.autoSizingType = AutoSizingTypeEnum.OFF; }
            catch (eAuto) { B.log.warn('autoSizingType: ' + eAuto.message); }

            function apply(size) {
                B.id.applyScale(frame, sizes, size / mx);
                B.id.setLocalBounds(frame, page, box);
                try { frame.recompose(); } catch (eRec) { }
                it++;
            }

            function fits(size) {
                apply(size);
                var gb = frame.geometricBounds;
                var fw = Math.abs(gb[3] - gb[1]), fh = Math.abs(gb[2] - gb[0]);
                if (fw > boxW + 0.75 || fh > boxH + 0.75) return false;
                if (!B.id.fits(frame)) return false;
                var ink = B.id.inkBox(frame);
                if (!ink) return false;
                return ink.w <= boxW + 0.5 && ink.h <= boxH + 0.5 &&
                    ink.x1 >= box.x1 - 2 && ink.x2 <= box.x2 + 2 &&
                    ink.y1 >= box.y1 - 2 && ink.y2 <= box.y2 + 2;
            }

            if (!fits(floorSize)) {
                apply(floorSize);
                return { from: B.geom.round(mx, 2), to: B.geom.round(floorSize, 2), iterations: it, overflow: true, mode: 'bubble' };
            }
            if (fits(ceiling)) {
                apply(ceiling);
                return { from: B.geom.round(mx, 2), to: B.geom.round(ceiling, 2), iterations: it, overflow: false, mode: 'bubble' };
            }

            /* invariant: lo fits, hi does not; keep the largest good size */
            var lo = floorSize, hi = ceiling, best = floorSize;
            var guard = 0;
            while (hi - lo > 0.15 && guard < 24) {
                guard++;
                var mid = (lo + hi) / 2;
                if (fits(mid)) { best = mid; lo = mid; } else { hi = mid; }
            }
            apply(best);
            return { from: B.geom.round(mx, 2), to: B.geom.round(best, 2), iterations: it, overflow: false, mode: 'bubble' };
        },

        /* look a layer up without creating it */
        findLayer: function (doc, name) {
            if (!name) return null;
            try {
                var L = doc.layers.itemByName(name);
                if (L && L.isValid) return L;
            } catch (e) { }
            return null;
        },

        /* temporarily hide layers by name; returns the list to restore */
        hideLayers: function (doc, names) {
            var hid = [], i, L;
            for (i = 0; i < names.length; i++) {
                L = B.id.findLayer(doc, names[i]);
                if (!L) continue;
                try {
                    if (L.visible) { L.visible = false; hid.push(L); }
                } catch (e) { }
            }
            return hid;
        },

        showLayers: function (hid) {
            var i;
            for (i = 0; i < hid.length; i++) {
                try { hid[i].visible = true; } catch (e) { }
            }
            return hid.length;
        },

        /* ---------- export ---------- */

        /* Every geometry number in ExtendScript follows
           app.scriptPreferences.measurementUnit, which DEFAULTS TO THE
           DOCUMENT'S RULER UNITS. On a file with millimetre rulers every
           pageWidth / geometricBounds value comes back in mm, which silently
           turns a 362 x 516 pt page into 128 x 182 and wrecks every
           comparison against the exported bitmap. Force points for the whole
           session - it also makes the numbers we hand back to InDesign
           mean what they say. */
        forcePoints: function () {
            try {
                var u = app.scriptPreferences.measurementUnit;
                if (u !== MeasurementUnits.POINTS) {
                    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
                    B.log.warn('计量单位不是点（' + u + '），已切换为 POINTS');
                }
                return true;
            } catch (e) {
                B.log.warn('无法切换计量单位: ' + e.message);
                return false;
            }
        },

        /* page: a Page object (preferred) or a page label string */
        exportPagePng: function (doc, page, file, dpi) {
            var p = app.pngExportPreferences;
            var prev = { range: p.pngExportRange, page: p.pageString, res: p.exportResolution, spread: p.exportingSpread };
            try {
                p.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;
                p.pageString = (typeof page === 'string' || typeof page === 'number') ? String(page) : B.id.pageLabel(page);
                p.exportResolution = dpi || 144;
                p.exportingSpread = false;
            } catch (e) { B.log.warn('png prefs: ' + e.message); }
            try {
                /* InDesign refuses to export into a folder that does not exist
                   yet ("无法找到文件夹"), so every caller gets its parent made
                   here instead of having to remember it. */
                try { if (!file.parent.exists) file.parent.create(); } catch (eMk) { }
                if (file.exists) file.remove();
                doc.exportFile(ExportFormat.PNG_FORMAT, file, false);
            } finally {
                try {
                    p.pngExportRange = prev.range;
                    p.pageString = prev.page;
                    p.exportResolution = prev.res;
                    p.exportingSpread = prev.spread;
                } catch (e2) { }
            }
            return file.exists ? file : null;
        },

        /* One EXPORT_ALL call for the whole run: InDesign 2025 ignores a Folder
           target (produces 0 files) but a File base name yields one PNG per
           page - "<base>.png" for page 1, "<base>2.png" .. "<base>N.png" after
           it. This replaces the per-page loop that used to toggle layers for
           every single page (the flicker the user reported). */
        exportPagesPng: function (doc, pages, dir, base, dpi) {
            var p = app.pngExportPreferences;
            var prev = { range: p.pngExportRange, page: p.pageString, res: p.exportResolution, spread: p.exportingSpread };
            pages = pages || doc.pages;
            base = base || 'page';
            dpi = dpi || 144;
            try {
                if (!dir.exists) dir.create();
                try {
                    var stale = dir.getFiles(base + '*.png'), si;
                    for (si = 0; si < stale.length; si++) { try { stale[si].remove(); } catch (eRm) { } }
                } catch (eCl) { }
                try {
                    p.pngExportRange = PNGExportRangeEnum.EXPORT_ALL;
                    p.exportResolution = dpi;
                    p.exportingSpread = false;
                } catch (ePref) { B.log.warn('png prefs: ' + ePref.message); }
                doc.exportFile(ExportFormat.PNG_FORMAT, new File(dir.fsName + '/' + base + '.png'), false);
            } catch (eExp) {
                B.log.warn('批量导出失败: ' + eExp.message + '（改用逐页导出）');
            } finally {
                try {
                    p.pngExportRange = prev.range;
                    p.pageString = prev.page;
                    p.exportResolution = prev.res;
                    p.exportingSpread = prev.spread;
                } catch (eRes) { }
            }
            var out = [], i;
            for (i = 0; i < pages.length; i++) {
                out.push({ page: pages[i], file: B.id.pngForPage(dir, base, pages[i], i) });
            }
            return out;
        },

        pngForPage: function (dir, base, page, index) {
            var label = B.id.pageLabel(page);
            var tries = [];
            if (label) tries.push(dir.fsName + '/' + base + label + '.png');
            tries.push(dir.fsName + '/' + base + (index + 1) + '.png');
            tries.push(dir.fsName + '/' + base + '.png');
            for (var i = 0; i < tries.length; i++) {
                try {
                    var f = new File(tries[i]);
                    if (f.exists) return f;
                } catch (e) { }
            }
            return null;
        },

        /* ---------- text ---------- */

        styleText: function (frame, family, size, leading) {
            try {
                var t = frame.texts[0];
                if (family) { try { t.appliedFont = family; } catch (eF) { B.log.warn('font ' + family + ': ' + eF.message); } }
                if (size) t.pointSize = size;
                if (leading) { try { t.leading = leading; } catch (eL) { } }
            } catch (e) { B.log.warn('styleText: ' + e.message); }
        },

        /* ---------- drawing (debug & clean) ----------
           Two DOM traps live here:
           1) InDesign 2025 refuses layer.polygons.add() / layer.rectangles.add()
              / layer.graphicLines.add() ("无法创建附加项目"), so shapes are
              created elsewhere and then moved onto the layer.
           2) doc.rectangles.add() lets InDesign pick the parent page from the
              geometry, and on a facing-page document it picks the FIRST page of
              the spread — debug shapes then show up on the wrong page and the
              page export looks unchanged. Creating them on the Page collection
              keeps parentPage correct.
           So: page-level collection first, document-level only as a fallback. */

        shapeHost: function (page, kind, bounds) {
            if (page) {
                try {
                    if (kind === 'polygons' && page.polygons) return page.polygons.add();
                    if (kind === 'rectangles' && page.rectangles) return page.rectangles.add({ geometricBounds: bounds });
                    if (kind === 'lines' && page.graphicLines) return page.graphicLines.add();
                } catch (ePage) { B.log.warn('page ' + kind + '.add: ' + ePage.message); }
            }
            var doc = page ? page.parent : null;
            if (!doc) throw new Error('shapeHost: 没有页面');
            if (kind === 'polygons') return doc.polygons.add();
            if (kind === 'rectangles') return doc.rectangles.add({ geometricBounds: bounds });
            return doc.graphicLines.add();
        },

        addPolygon: function (layer, path, stroke, fill, weight, page) {
            var shape = B.id.shapeHost(page, 'polygons', null);
            try { shape.itemLayer = layer; } catch (eL) { B.log.warn('polygon layer: ' + eL.message); }
            try {
                shape.paths[0].entirePath = path;
            } catch (e) {
                B.log.warn('polygon entirePath: ' + e.message);
                try { shape.remove(); } catch (e2) { }
                return null;
            }
            try { shape.strokeWeight = (weight === undefined ? 1 : weight); } catch (e3) { }
            if (stroke) { try { shape.strokeColor = stroke; } catch (e4) { } }
            if (fill) { try { shape.fillColor = fill; } catch (e5) { } }
            try { shape.strokeAlignment = StrokeAlignment.CENTER_ALIGNMENT; } catch (e6) { }
            return shape;
        },

        addRect: function (layer, rect, stroke, fill, weight, page) {
            var shape = B.id.shapeHost(page, 'rectangles', B.geom.toBounds(rect));
            try { shape.itemLayer = layer; } catch (eL) { B.log.warn('rect layer: ' + eL.message); }
            try { shape.strokeWeight = (weight === undefined ? 1 : weight); } catch (e) { }
            if (stroke) { try { shape.strokeColor = stroke; } catch (e2) { } }
            if (fill) { try { shape.fillColor = fill; } catch (e3) { } }
            try { shape.strokeAlignment = StrokeAlignment.CENTER_ALIGNMENT; } catch (e4) { }
            return shape;
        },

        addLine: function (layer, x1, y1, x2, y2, stroke, weight, page) {
            var line = B.id.shapeHost(page, 'lines', null);
            try { line.itemLayer = layer; } catch (eL) { B.log.warn('line layer: ' + eL.message); }
            try {
                line.paths[0].entirePath = [[x1, y1], [x2, y2]];
            } catch (e) { try { line.remove(); } catch (e2) { } return null; }
            try { line.strokeWeight = weight || 1; } catch (e3) { }
            if (stroke) { try { line.strokeColor = stroke; } catch (e4) { } }
            return line;
        },

        noneSwatch: function (doc) {
            return B.id.swatch(doc, 'None') || B.id.swatch(doc, '无') || B.id.swatch(doc, 'なし');
        },

        paperSwatch: function (doc) {
            return B.id.swatch(doc, 'Paper') || B.id.swatch(doc, '纸色');
        }
    };

    /* self-reference so nested calls read naturally */
    api.id = api;
    return api;
})();
