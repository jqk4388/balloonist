/* ==========================================================================
   Balloonist · ScriptUI panel

   Design constraints learned the hard way in InDesign 2025:
   - a ScriptUI panel has NO clipping and NO custom scrolling: it always grows
     to the natural size of its content, and `preferredSize` on the window is
     overridden by layout (measured: asked 380x540, got 1474x891);
   - controls have no `remove()` method (only Window does), so a panel cannot be
     emptied and refilled - every rebuild has to be a NEW window;
   - `alignChildren = 'fill'` on a column feeds the window's own width back into
     its children and makes the palette creep wider on every relayout.

   Therefore: the main palette stays deliberately small - a native-scrolling
   listbox of features plus three buttons - and each feature's options open in
   their own small palette that is built fresh and thrown away on close.
   ========================================================================== */

B.ui = (function () {

    var win = null, status = null, lst = null, sel = null;
    var optWin = null;

    function say(text, isError) {
        if (status) {
            status.text = text;
            try {
                status.graphics.foregroundColor = status.graphics.newPen(
                    status.graphics.PenType.SOLID_COLOR,
                    isError ? [0.75, 0, 0, 1] : [0, 0.35, 0.1, 1], 1);
            } catch (e) { }
        }
        B.log.info('[panel] ' + text);
        try { if (win) win.update(); } catch (e2) { }
    }

    function runFeature(f) {
        if (!f) return;
        say('运行 ' + f.title + ' …');
        var res = null;
        try {
            res = B.run(f.id);
        } catch (e) {
            say('✗ ' + f.title + '：' + e.message, true);
            return;
        }
        say((res.ok ? '✓ ' : '✗ ') + (res.message || res.error || '完成') + '  ' + res.ms + 'ms', !res.ok);
    }

    /* ---- option editors -------------------------------------------------- */

    function editNumber(owner, feature, opt, width) {
        var row = owner.add('group');
        row.orientation = 'row';
        row.alignChildren = ['left', 'center'];
        row.spacing = 4;
        var lab = row.add('statictext', undefined, opt.label);
        lab.preferredSize = [width - 56, 20];
        var ed = row.add('edittext', undefined, String(B.config.opt(feature.id)[opt.key]));
        ed.preferredSize = [50, 20];
        ed.onChange = function () {
            var v = parseFloat(ed.text);
            if (isNaN(v)) { ed.text = String(B.config.opt(feature.id)[opt.key]); return; }
            B.config.setOpt(feature.id, opt.key, v);
        };
    }

    function editText(owner, feature, opt, width) {
        var row = owner.add('group');
        row.orientation = 'row';
        row.alignChildren = ['left', 'center'];
        row.spacing = 4;
        /* a 64 pt label clipped "检测器 (blobs/auto)" down to "检测器 (b"; give
           the label room and let the field take the rest */
        var lab = row.add('statictext', undefined, opt.label);
        lab.preferredSize = [132, 20];
        var ed = row.add('edittext', undefined, String(B.config.opt(feature.id)[opt.key] || ''));
        ed.preferredSize = [width - 138, 20];
        ed.onChange = function () { B.config.setOpt(feature.id, opt.key, ed.text); };
    }

    function editBool(owner, feature, opt) {
        var cb = owner.add('checkbox', undefined, opt.label);
        cb.value = B.config.opt(feature.id)[opt.key] !== false;
        cb.onClick = function () { B.config.setOpt(feature.id, opt.key, cb.value); };
    }

    /* Opens a separate, small palette for one feature's options. Numbers and
       text fields go full width, booleans are packed two per row, so even the
       13-option alignAll stays inside ~220 pt of height. */
    function openOptions(feature, onDone) {
        if (!feature) return null;
        if (optWin) { try { optWin.close(); } catch (e0) { } optWin = null; }

        var opts = feature.options || [];
        var w = new Window('palette', feature.title + ' · 选项');
        w.orientation = 'column';
        w.alignChildren = ['left', 'top'];
        w.margins = 12;
        w.spacing = 8;

        var head = w.add('statictext', undefined, feature.title);
        try { head.graphics.font = ScriptUI.newFont('dialog', ScriptUI.FontStyle.BOLD, 12); } catch (e) { }
        var desc = w.add('statictext', undefined, feature.desc || '', { multiline: true });
        desc.preferredSize = [300, 34];

        if (!opts.length) {
            w.add('statictext', undefined, '这个功能没有可调项。');
        } else {
            var box = w.add('panel');
            box.orientation = 'column';
            box.alignChildren = ['left', 'top'];
            box.margins = 10;
            box.spacing = 5;
            var bools = [], i;
            for (i = 0; i < opts.length; i++) {
                var o = opts[i];
                if (o.type === 'number') editNumber(box, feature, o, 300);
                else if (o.type === 'text') editText(box, feature, o, 300);
                else bools.push(o);
            }
            var r;
            for (r = 0; r < bools.length; r += 2) {
                var row = box.add('group');
                row.orientation = 'row';
                row.alignChildren = ['left', 'center'];
                row.spacing = 10;
                var cell;
                for (cell = 0; cell < 2; cell++) {
                    var cellG = row.add('group');
                    cellG.orientation = 'column';
                    cellG.alignChildren = ['left', 'center'];
                    cellG.preferredSize = [150, 20];
                    if (bools[r + cell]) editBool(cellG, feature, bools[r + cell]);
                }
            }
        }

        var foot = w.add('group');
        foot.orientation = 'row';
        foot.alignChildren = ['left', 'center'];
        foot.spacing = 8;
        var bRun = foot.add('button', undefined, '保存并运行');
        bRun.onClick = function () {
            try { w.close(); } catch (e) { }
            optWin = null;
            runFeature(feature);
            if (onDone) onDone();
        };
        var bOk = foot.add('button', undefined, '保存');
        bOk.onClick = function () {
            try { w.close(); } catch (e) { }
            optWin = null;
            say('已保存 ' + feature.title + ' 的选项');
            if (onDone) onDone();
        };
        var bCfg = foot.add('button', undefined, '配置文件');
        bCfg.onClick = function () { B.config.openFile(); };

        optWin = w;
        w.show();
        /* park it to the LEFT of the main palette: the main one usually sits near
           the right edge of the display, so a right-hand offset would push the
           options palette off-screen (measured: 2190 px on a 2560 px screen) */
        try {
            var mb = win ? win.bounds : null;
            var ow2 = w.bounds[2] - w.bounds[0], oh = w.bounds[3] - w.bounds[1];
            var x = mb ? mb[0] - ow2 - 14 : 160, y = mb ? mb[1] : 120;
            if (x < 8) x = 8;
            w.bounds = [x, y, x + ow2, y + oh];
        } catch (eMove) { }
        return w;
    }

    /* ---- main palette ---------------------------------------------------- */

    function build() {
        var feats = B.reg.visible();

        var w = new Window('palette', 'Balloonist · 气泡工作台  v' + B.VERSION);
        w.orientation = 'column';
        w.alignChildren = ['left', 'top'];
        w.margins = 12;
        w.spacing = 7;

        var title = w.add('statictext', undefined, 'Balloonist · 气泡工作台');
        try { title.graphics.font = ScriptUI.newFont('dialog', ScriptUI.FontStyle.BOLD, 13); } catch (e) { }
        w.add('statictext', undefined, feats.length + ' 个功能 · v' + B.VERSION + ' · 双击列表可直接运行');

        /* the list scrolls natively - the only reliable scrolling in ScriptUI */
        lst = w.add('listbox', undefined, [], { numberOfColumns: 1, showHeaders: false, multiselect: false });
        lst.preferredSize = [340, 156];
        var i;
        for (i = 0; i < feats.length; i++) {
            lst.add('item', '[' + (feats[i].group || '功能') + '] ' + feats[i].title);
        }
        lst.onChange = function () {
            var idx = lst.selection ? lst.selection.index : -1;
            sel = (idx >= 0 && idx < feats.length) ? feats[idx] : null;
        };
        lst.onDoubleClick = function () {
            var idx = lst.selection ? lst.selection.index : -1;
            if (idx >= 0 && idx < feats.length) runFeature(feats[idx]);
        };

        var btnRow = w.add('group');
        btnRow.orientation = 'row';
        btnRow.alignChildren = ['left', 'center'];
        btnRow.spacing = 8;
        var bRun = btnRow.add('button', undefined, '运行选中功能');
        bRun.preferredSize = [186, 27];
        bRun.onClick = function () { runFeature(sel); };
        var bOpt = btnRow.add('button', undefined, '选项…');
        bOpt.preferredSize = [136, 27];
        bOpt.onClick = function () { openOptions(sel, null); };

        status = w.add('statictext', undefined, '就绪。', { multiline: true });
        status.preferredSize = [340, 42];

        var foot = w.add('group');
        foot.orientation = 'row';
        foot.alignChildren = ['left', 'center'];
        foot.spacing = 5;
        var bCache = foot.add('button', undefined, '重新检测');
        bCache.onClick = function () { B.ops.clearCache(); say('缓存已清空，下次运行会重新分析气泡'); };
        var bTmp = foot.add('button', undefined, '清临时');
        bTmp.onClick = function () {
            var n = B.ops.clearTmp();
            say('临时文件夹已清空（' + n + ' 项）');
        };
        var bLog = foot.add('button', undefined, '日志');
        bLog.onClick = function () { B.log.open(); };
        var bCfg = foot.add('button', undefined, '配置');
        bCfg.onClick = function () { B.config.openFile(); };
        var bReload = foot.add('button', undefined, '重载');
        bReload.onClick = function () { B.ui.reload(); };

        /* Resizing is clamped to fixed bounds rather than to $.screens: ScriptUI
           window bounds are in LOGICAL points while $.screens reports physical
           pixels (150 % display scaling here made every screen-derived limit 1.5x
           too generous and let the palette run past the right edge). */
        w.onResizing = function () {
            var bw = this.bounds[2] - this.bounds[0], bh = this.bounds[3] - this.bounds[1];
            this.preferredSize = [Math.max(300, Math.min(bw, 460)), Math.max(240, Math.min(bh, 720))];
        };

        /* Positioning a ScriptUI window is only partially under script control:
           assigning bounds before show() is ignored (InDesign keeps its own
           default spot), while center() works but re-bases the window so its
           reported bounds inflate. center() then leave it alone - the palette
           lands on-screen, and the user can drag it. */
        try { w.center(); } catch (eCenter) { B.log.warn('center failed: ' + eCenter.message); }

        return w;
    }

    return {
        show: function () {
            if (win) {
                try { win.show(); win.active = true; return win; } catch (e) { win = null; }
            }
            win = build();
            win.show();
            var feats = B.reg.visible();
            if (feats.length) { lst.selection = 0; sel = feats[0]; }
            return win;
        },
        options: function (id) {
            var f = B.reg.get(id);
            return openOptions(f, null);
        },
        reload: function () {
            try { if (optWin) optWin.close(); } catch (e) { }
            optWin = null;
            try { if (win) win.close(); } catch (e2) { }
            win = null; lst = null; status = null; sel = null;
            B.ops.clearCache();
            B.ui.show();
        },
        close: function () {
            try { if (optWin) optWin.close(); } catch (e) { }
            optWin = null;
            try { if (win) win.close(); } catch (e2) { }
            win = null; lst = null; status = null; sel = null;
        },
        say: say,
        window: function () { return win; },
        optionsWindow: function () { return optWin; }
    };
})();
