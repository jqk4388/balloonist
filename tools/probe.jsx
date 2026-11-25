// 通用诊断脚本：只读取当前文档的信息，不修改任何内容。
// 用法：pwsh tools/run-jsx.ps1 -Jsx tools/probe.jsx
// 返回值约定：OK，或 ERR 名称: 消息 @行号。
(function () {
    function line(s) { $.writeln(s); }

    try {
        if (!app.documents.length) {
            return "ERR Document: 没有打开的文档";
        }

        var doc = app.activeDocument;
        line("document=" + doc.name);
        line("pages=" + doc.pages.length);
        line("textFrames=" + doc.textFrames.length);
        line("layers=" + doc.layers.length);
        line("selection=" + (app.selection ? app.selection.length : 0));
        line("measurementUnit=" + app.scriptPreferences.measurementUnit);

        for (var i = 0; i < doc.layers.length; i++) {
            line("layer[" + i + "]=" + doc.layers[i].name);
        }

        if ($.global.Balloonist && $.global.Balloonist.cfg) {
            line("balloonist=loaded");
            line("configVersion=" + ($.global.Balloonist.cfg.version || "unknown"));
        } else {
            line("balloonist=not-loaded");
        }

        return "OK";
    } catch (e) {
        return "ERR " + (e.name || "Error") + ": " + (e.message || String(e)) + " @" + (e.line || 0);
    }
})();
