/* ==========================================================================
   Balloonist · mini JSON — tolerant stringify/parse for ExtendScript
   Native JSON exists in modern InDesign; the fallback keeps CS6 happy and
   lets us survive pretty-print quirks.
   ========================================================================== */

B.json = (function () {
    var nativeOk = (typeof JSON !== 'undefined' && JSON && typeof JSON.parse === 'function' && typeof JSON.stringify === 'function');

    function esc(s) {
        var i, ch, out = '';
        for (i = 0; i < s.length; i++) {
            ch = s.charAt(i);
            if (ch === '"') out += '\\"';
            else if (ch === '\\') out += '\\\\';
            else if (ch === '\n') out += '\\n';
            else if (ch === '\r') out += '\\r';
            else if (ch === '\t') out += '\\t';
            else if (ch < ' ') out += '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
            else out += ch;
        }
        return out;
    }

    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    function strFallback(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return '"' + esc(v) + '"';
        if (isArray(v)) {
            var a = [], i;
            for (i = 0; i < v.length; i++) a.push(strFallback(v[i]));
            return '[' + a.join(',') + ']';
        }
        if (t === 'object') {
            var o = [], k;
            for (k in v) {
                if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== 'function' && v[k] !== undefined) {
                    o.push(strFallback(k) + ':' + strFallback(v[k]));
                }
            }
            return '{' + o.join(',') + '}';
        }
        return 'null';
    }

    function parseFallback(text) {
        var i = 0;
        function ws() { while (i < text.length && ' \t\r\n'.indexOf(text.charAt(i)) >= 0) i++; }
        function fail(m) { throw new Error('JSON: ' + m + ' at ' + i); }
        function val() {
            ws();
            var c = text.charAt(i);
            if (c === '{') return obj();
            if (c === '[') return arr();
            if (c === '"') return pstr();
            if (text.substr(i, 4) === 'true') { i += 4; return true; }
            if (text.substr(i, 5) === 'false') { i += 5; return false; }
            if (text.substr(i, 4) === 'null') { i += 4; return null; }
            return num();
        }
        function obj() {
            var o = {}, key;
            i++;
            ws();
            if (text.charAt(i) === '}') { i++; return o; }
            while (i < text.length) {
                ws();
                if (text.charAt(i) !== '"') fail('key');
                key = pstr();
                ws();
                if (text.charAt(i) !== ':') fail('colon');
                i++;
                o[key] = val();
                ws();
                if (text.charAt(i) === ',') { i++; continue; }
                if (text.charAt(i) === '}') { i++; return o; }
                fail('object end');
            }
            fail('unterminated object');
        }
        function arr() {
            var a = [];
            i++;
            ws();
            if (text.charAt(i) === ']') { i++; return a; }
            while (i < text.length) {
                a.push(val());
                ws();
                if (text.charAt(i) === ',') { i++; continue; }
                if (text.charAt(i) === ']') { i++; return a; }
                fail('array end');
            }
            fail('unterminated array');
        }
        function pstr() {
            var out = '', c;
            i++;
            while (i < text.length) {
                c = text.charAt(i++);
                if (c === '"') return out;
                if (c === '\\') {
                    c = text.charAt(i++);
                    if (c === 'n') out += '\n';
                    else if (c === 't') out += '\t';
                    else if (c === 'r') out += '\r';
                    else if (c === 'b') out += '\b';
                    else if (c === 'f') out += '\f';
                    else if (c === 'u') {
                        out += String.fromCharCode(parseInt(text.substr(i, 4), 16));
                        i += 4;
                    } else out += c;
                } else out += c;
            }
            fail('unterminated string');
        }
        function num() {
            var start = i, c;
            while (i < text.length) {
                c = text.charAt(i);
                if ('0123456789+-.eE'.indexOf(c) >= 0) i++;
                else break;
            }
            if (start === i) fail('number');
            var n = Number(text.substring(start, i));
            if (isNaN(n)) fail('bad number');
            return n;
        }
        var v = val();
        return v;
    }

    function str(v) {
        if (nativeOk) { try { return JSON.stringify(v); } catch (e) { } }
        return strFallback(v);
    }

    function parse(s) {
        if (s === null || s === undefined) return null;
        s = String(s);
        if (s.length === 0) return null;
        if (nativeOk) { try { return JSON.parse(s); } catch (e) { } }
        return parseFallback(s);
    }

    function write(file, obj) {
        var txt = str(obj);
        file.encoding = 'UTF-8';
        if (file.open('w')) {
            file.write(txt);
            file.close();
            return true;
        }
        return false;
    }

    function read(file) {
        if (!file.exists) return null;
        file.encoding = 'UTF-8';
        if (!file.open('r')) return null;
        var txt = file.read();
        file.close();
        return parse(txt);
    }

    return { str: str, parse: parse, write: write, read: read, strFallback: strFallback, parseFallback: parseFallback };
})();

B.writeJson = function (file, obj) { return B.json.write(file, obj); };
