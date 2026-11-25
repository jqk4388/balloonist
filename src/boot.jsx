/* ==========================================================================
   Balloonist · boot
   Loads config, announces itself, opens the panel unless running headless.
   Set $.global.BALLOONIST_HEADLESS = true before loading to get the API only.
   ========================================================================== */

B.config.load();

B.log.info('--- boot v' + B.VERSION + ' (' + B.BUILD + ') engine=' + $.engineName + ' ---');
B.log.info('script=' + B.paths.script);
B.log.info('root=' + B.paths.root.fsName);
B.log.info('features=' + B.reg.all().length + ' raster=' + (B.raster.exePath() || 'NOT FOUND'));

if (!$.global.BALLOONIST_HEADLESS && B.cfg.showPanelOnLoad !== false) {
    try {
        B.ui.show();
    } catch (e) {
        B.log.error('panel failed: ' + e.message + ' @' + e.line);
    }
}
