/* ==========================================================================
   Balloonist · log — append-only text log + console echo
   ========================================================================== */

B.log = (function () {
    var MAX_BYTES = 512 * 1024;

    function two(n) { return (n < 10 ? '0' : '') + n; }
    function now() {
        var d = new Date();
        return '' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
            ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    }

    function append(level, msg) {
        var line = now() + ' [' + level + '] ' + msg + '\n';
        try {
            var f = B.paths.log;
            if (f.exists && f.length > MAX_BYTES) f.remove();
            f.encoding = 'UTF-8';
            if (f.open('a')) { f.write(line); f.close(); }
        } catch (e) { }
        try { $.writeln(line.replace(/\n$/, '')); } catch (e2) { }
        return line;
    }

    return {
        info: function (m) { return append('INFO', m); },
        warn: function (m) { return append('WARN', m); },
        error: function (m) { return append('ERR ', m); },
        file: function () { return B.paths.log; },
        open: function () {
            var f = B.paths.log;
            if (!f.exists) { f.encoding = 'UTF-8'; if (f.open('w')) { f.write(''); f.close(); } }
            f.execute();
        },
        tail: function (lines) {
            var n = lines || 40, out = [];
            try {
                var f = B.paths.log;
                if (!f.exists) return '';
                f.encoding = 'UTF-8';
                f.open('r');
                var all = f.read().split('\n');
                f.close();
                for (var i = Math.max(0, all.length - n); i < all.length; i++) out.push(all[i]);
            } catch (e) { }
            return out.join('\n');
        }
    };
})();
