/* ==========================================================================
   Balloonist · raster bridge
   InDesign ExtendScript cannot read pixels, so page analysis is delegated to
   the BalloonistRaster helper (tools/raster, pure Go, one binary per OS).
   Request file in, JSON out.

   Launching differs per platform because ExtendScript has no shell of its own:
     Windows  -> generated .vbs, WScript.Shell.Run with window style 0 (hidden)
     macOS    -> generated .sh, run through AppleScript "do shell script"

   Two calls:
     detect(img, rects, settings)   -> one result per text frame rect
     bubbles(img, settings)         -> every speech bubble on the page
                                        (detect='blobs' | 'survey' | 'auto')
   ========================================================================== */

B.raster = (function () {

    var MAC = (Folder.fs === 'Macintosh');

    function exists(p) {
        try { return p && new File(p).exists; } catch (e) { return false; }
    }

    /* Windows command line: double quotes, CR/LF would break the .vbs */
    function q(s) { return '"' + String(s).replace(/\r/g, '').replace(/\n/g, '') + '"'; }

    /* POSIX shell: single quotes, embedded quote closes/escapes/reopens */
    function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

    /* AppleScript string literal */
    function asq(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

    function base(settings) {
        var lines = [];
        lines.push('scale=' + ((settings.dpi || 144) / 72));
        lines.push('pad=' + (settings.pad === undefined ? 0.035 : settings.pad));
        lines.push('thr=' + (settings.thr === undefined ? 200 : settings.thr));
        lines.push('dil=' + (settings.dil === undefined ? 1 : settings.dil));
        lines.push('h=' + (settings.h === undefined ? 0.35 : settings.h));
        if (settings.debugDump) lines.push('dump=' + B.paths.tmp.fsName + '/dump-' + B.paths.stamp() + '.png');
        return lines;
    }

    function writeRequest(file, imgPath, lines) {
        var all = ['img=' + imgPath].concat(lines);
        file.encoding = 'UTF-8';
        if (!file.open('w')) throw new Error('cannot write request: ' + file.fsName);
        file.write(all.join('\n') + '\n');
        file.close();
    }

    function readText(file) {
        try {
            if (!file.exists) return '';
            file.encoding = 'UTF-8';
            if (!file.open('r')) return '';
            var txt = String(file.read());
            file.close();
            return txt;
        } catch (e) { return ''; }
    }

    /* Windows: hidden process through a one-shot .vbs. cmd /c keeps a log of
       the helper's own stderr, so a broken path or a bad PNG shows up in the
       timeout message instead of just "no result after 20 s". */
    function launchWindows(exePath, reqPath, resPath) {
        var log = new File(B.paths.tmp.fsName + '/raster-' + B.paths.stamp() + '.log');
        var inner = q(exePath) + ' ' + q(reqPath) + ' ' + q(resPath) + ' > ' + q(log.fsName) + ' 2>&1';
        var cmd = 'cmd /c "' + inner + '"';
        var vbs = new File(B.paths.tmp.fsName + '/run-' + B.paths.stamp() + '.vbs');
        vbs.encoding = 'UTF-8';
        vbs.open('w');
        vbs.write('Set sh = CreateObject("WScript.Shell")\r\n');
        vbs.write('sh.Run "' + cmd.replace(/"/g, '""') + '", 0, False\r\n');
        vbs.close();
        var ok = vbs.execute();
        if (!ok) {
            try { vbs.remove(); } catch (e) { }
            throw new Error('cannot launch raster helper (VBS execute failed): ' + exePath);
        }
        return { launcher: vbs, log: log };
    }

    /* macOS: a tiny .sh backgrounds the helper, AppleScript starts the .sh.
       "do shell script" waits for its own command only; the helper's output
       goes to a log file so nothing is left on a pipe. */
    function launchMac(exePath, reqPath, resPath) {
        var tag = B.paths.stamp();
        var log = new File(B.paths.tmp.fsName + '/raster-' + tag + '.log');
        var script = new File(B.paths.tmp.fsName + '/run-' + tag + '.sh');
        script.encoding = 'UTF-8';
        if (!script.open('w')) throw new Error('cannot write launcher: ' + script.fsName);
        script.write('#!/bin/sh\n');
        /* a copy that lost its +x bit (zip, git checkout on a FAT drive)
           still runs after this line */
        script.write('chmod +x ' + shq(exePath) + ' 2>/dev/null\n');
        script.write(shq(exePath) + ' ' + shq(reqPath) + ' ' + shq(resPath) +
                     ' > ' + shq(log.fsName) + ' 2>&1 &\n');
        script.close();

        var as = 'do shell script ' + asq('/bin/sh ' + shq(script.fsName) + ' > /dev/null 2>&1');
        var started = false;
        try { app.doScript(as, ScriptLanguage.APPLESCRIPT_LANGUAGE); started = true; } catch (eAs) { }
        if (!started) {
            /* fallback: let the OS run the script directly */
            try { started = script.execute(); } catch (eEx) { started = false; }
        }
        if (!started) {
            try { script.remove(); } catch (eRm) { }
            throw new Error('cannot launch raster helper on macOS: ' + exePath);
        }
        return { launcher: script, log: log };
    }

    function launch(exePath, reqPath, resPath) {
        return MAC ? launchMac(exePath, reqPath, resPath) : launchWindows(exePath, reqPath, resPath);
    }

    /* one hidden run, returns the parsed JSON or throws */
    function call(imgPath, lines, settings) {
        var exe = B.raster.exePath();
        if (!exe) {
            throw new Error('未找到分析器 ' + (MAC ? 'tools/raster/BalloonistRaster' : 'tools/raster/BalloonistRaster.exe') +
                            '（可在配置里设置 rasterExe）');
        }
        if (!exists(imgPath)) throw new Error('页面导出文件不存在: ' + imgPath);

        var tag = B.paths.stamp('raster');
        var req = new File(B.paths.tmp.fsName + '/req-' + tag + '.txt');
        var res = new File(B.paths.tmp.fsName + '/res-' + tag + '.json');
        writeRequest(req, imgPath, lines);
        if (res.exists) res.remove();

        var t0 = new Date().getTime();
        var run = launch(exe, req.fsName, res.fsName);
        var timeout = settings.rasterTimeoutMs || 20000;
        var data = null, waited = 0;

        while (waited < timeout) {
            if (res.exists && res.length > 4) {
                data = B.json.read(res);
                if (data && (data.results || data.bubbles)) break;
            }
            $.sleep(20);
            waited = new Date().getTime() - t0;
        }

        try { run.launcher.remove(); } catch (eRm) { }

        /* the helper's own stderr (both platforms redirect it to run.log):
           without it a quarantined, wrong-arch or missing binary just looks
           like a timeout */
        var hint = '';
        if (!data && run.log && run.log.exists) {
            var txt = readText(run.log);
            if (txt) hint = '（' + txt.replace(/\s+/g, ' ').slice(0, 240) + '）';
        }

        if (!settings.debugDump) {
            try { if (req.exists) req.remove(); } catch (e2) { }
            try { if (res.exists) res.remove(); } catch (e3) { }
            try { if (run.log && run.log.exists) run.log.remove(); } catch (e4) { }
        }

        if (!data) throw new Error('气泡分析超时（' + timeout + 'ms）' + hint);
        return data;
    }

    function pushThresholds(lines, settings) {
        lines.push('minside=' + (settings.minSide === undefined ? 0 : settings.minSide));
        lines.push('minarea=' + (settings.minArea === undefined ? 0 : settings.minArea));
        lines.push('maxarea=' + (settings.maxArea === undefined ? 0.09 : settings.maxArea));
        lines.push('maxaspect=' + (settings.maxAspect === undefined ? 3.5 : settings.maxAspect));
    }

    /* bright, ink-enclosed regions: the only detector that survives screentone
       backgrounds and lettering that already sits inside the bubble */
    function blobsPass(imgPath, settings) {
        var lines = base(settings);
        lines.push('mode=blobs');
        pushThresholds(lines, settings);
        lines.push('lthr=' + (settings.lightThr === undefined ? 205 : settings.lightThr));
        lines.push('fillrate=' + (settings.minFill === undefined ? 0.55 : settings.minFill));
        var data = call(imgPath, lines, settings);
        return data.bubbles || null;
    }

    /* watershed over the dilated paper mask (clean, unlettered art) */
    function surveyPass(imgPath, settings) {
        var lines = base(settings);
        lines.push('mode=bubbles');
        pushThresholds(lines, settings);
        /* 0 = accept painted-over rectangles with no outline left;
           0.3 = require a real ink outline (untouched manga art) */
        lines.push('ring=' + (settings.minRingInk === undefined ? 0 : settings.minRingInk));
        /* how completely a basin fills its bounding box: circles score
           ~0.78, faces and paper pockets far less, clean boxes ~1 */
        lines.push('rfill=' + (settings.minRectFill === undefined ? 0.72 : settings.minRectFill));
        var data = call(imgPath, lines, settings);
        return data.bubbles || null;
    }

    return {

        /* search order: configured path -> repo/tools/raster -> <userData>/Balloonist/tools/raster
           (the install script copies the helper into the last one, so the plugin
            keeps working when the .jsx sits in InDesign's Scripts Panel on another drive).
           macOS gets a wrapper named BalloonistRaster (it picks the CPU-specific
           build), plus the per-architecture names as a fallback. */
        exePath: function () {
            var explicit = B.cfg.rasterExe;
            if (exists(explicit)) return new File(explicit).fsName;
            var files = MAC
                ? ['BalloonistRaster', 'BalloonistRaster-osx-arm64', 'BalloonistRaster-osx-x64']
                : ['BalloonistRaster.exe'];
            var dirs = ['/tools/raster/', '/raster/', '/'];
            /* the script is often copied into another repo or into the Scripts
               Panel, so the analyser can live in several places - search them
               all and remember the one that answered */
            var roots = [B.paths.root.fsName, B.paths.home.fsName,
                         Folder.userData.fsName + '/Adobe/InDesign/Scripts Panel',
                         Folder.current.fsName];
            /* B.paths.script is a STRING (the .jsx file path), the folders are
               root / dist (the folder holding the script) / home. Walk up two
               levels from the script so a copy living inside another repo still
               finds ../tools/raster/. */
            var d = B.paths.dist, step;
            for (step = 0; step < 3 && d; step++) {
                roots.push(d.fsName);
                try { d = d.parent; } catch (eUp) { d = null; }
                if (d && !d.exists) d = null;
            }
            for (var rr = 0; rr < roots.length; rr++) {
                if (!roots[rr]) continue;
                for (var dd = 0; dd < dirs.length; dd++) {
                    for (var ff = 0; ff < files.length; ff++) {
                        var f = new File(roots[rr] + dirs[dd] + files[ff]);
                        try {
                            if (f.exists) {
                                /* sticky: next session does not have to search again */
                                try {
                                    if (B.cfg && !B.cfg.rasterExe) { B.cfg.rasterExe = f.fsName; B.config.save(); }
                                } catch (eSave) { }
                                return f.fsName;
                            }
                        } catch (e) { }
                    }
                }
            }
            return null;
        },

        /* rects: array of page-point rects [x1,y1,x2,y2]; returns one result each */
        detect: function (imgPath, rects, settings) {
            /* the helper rejects a request with no rect ("img or rect missing"),
               which would only surface as a 20 s timeout here */
            if (!rects || !rects.length) return [];
            var lines = base(settings);
            for (var i = 0; i < rects.length; i++) lines.push('rect=' + B.geom.toArray(rects[i]).join(','));
            var data = call(imgPath, lines, settings);
            if (!data.results) throw new Error('气泡分析没有返回结果');
            if (data.results.length !== rects.length) {
                B.log.warn('raster returned ' + data.results.length + ' results for ' + rects.length + ' rects');
            }
            return data.results;
        },

        /* every bubble on the page, page points.
           detect='blobs'  - bright regions enclosed by ink (already-lettered
                             scans, screentone backgrounds)
           detect='survey' - watershed over the paper mask (clean white art)
           detect='auto'   - blobs first, survey when nothing was found */
        bubbles: function (imgPath, settings) {
            var want = settings.detect || 'auto';
            var list = null;
            if (want === 'blobs' || want === 'auto') list = blobsPass(imgPath, settings);
            if ((!list || !list.length) && want !== 'blobs') list = surveyPass(imgPath, settings);
            if (!list) throw new Error('气泡检测没有返回结果');
            return list;
        }
    };
})();
