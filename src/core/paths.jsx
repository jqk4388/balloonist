/* ==========================================================================
   Balloonist · 气泡工作台 — paths & runtime folders
   Decides where the script lives, where config/log/tmp files go.
   ========================================================================== */

B.paths = (function () {
    var scriptPath = ($.fileName && $.fileName.length > 2) ? $.fileName : '';
    var here = null;
    if (scriptPath.indexOf('/') >= 0 || scriptPath.indexOf('\\') >= 0) {
        try { here = new File(scriptPath).parent; } catch (e) { here = null; }
    }
    if (!here || !here.exists) here = new Folder(Folder.userData.fsName);
    var root = (here.name === 'dist') ? here.parent : here;

    var homePath = $.global.BALLOONIST_HOME || (Folder.userData.fsName + '/Balloonist');
    var home = new Folder(homePath);
    if (!home.exists) home.create();
    var tmp = new Folder(home.fsName + '/tmp');
    if (!tmp.exists) tmp.create();

    return {
        script: scriptPath,
        dist: here,
        root: root,
        home: home,
        tmp: tmp,
        cfg: new File(home.fsName + '/balloonist.config.json'),
        log: new File(home.fsName + '/balloonist.log'),
        last: new File(home.fsName + '/last-result.json'),
        seq: 0,
        stamp: function (tag) {
            B.paths.seq++;
            var t = new Date();
            var s = '' + t.getFullYear() + ('0' + (t.getMonth() + 1)).slice(-2) + ('0' + t.getDate()).slice(-2) +
                '-' + ('0' + t.getHours()).slice(-2) + ('0' + t.getMinutes()).slice(-2) +
                ('0' + t.getSeconds()).slice(-2) + '-' + B.paths.seq;
            return (tag ? tag + '-' : '') + s;
        }
    };
})();
