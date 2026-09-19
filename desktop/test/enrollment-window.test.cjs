const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEnrollmentWindow } = require('../main/enrollment-window');

test('enrollment reuses an isolated window and restricts top-level navigation', async () => {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.popup = fn; }; windows.push(this); }
    setMenuBarVisibility() {}
    async loadURL(url) { this.url = url; }
    isDestroyed() { return false; }
    focus() { this.focused = true; }
    close() { this.emit('closed'); }
  }
  const session = { setPermissionRequestHandler(fn) { this.request = fn; }, setPermissionCheckHandler(fn) { this.check = fn; } };
  const open = createEnrollmentWindow({ BrowserWindow: Window, session: { fromPartition: () => session } });
  await open(); await open();
  assert.equal(windows.length, 1);
  const win = windows[0];
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.preload, undefined);
  assert.equal(win.options.webPreferences.session, session);
  assert.match(win.url, /claim.html\?client=desktop$/);
  const details = { isMainFrame: true, requestingUrl: win.url };
  assert.equal(session.check(null, 'clipboard-sanitized-write', 'https://ltools.asia', details), true);
  assert.equal(session.check(null, 'clipboard-read', 'https://ltools.asia', details), false);
  assert.equal(session.check(null, 'clipboard-sanitized-write', 'https://ltools.asia', { ...details, isMainFrame: false }), false);
  assert.equal(session.check(null, 'clipboard-sanitized-write', 'https://evil.example', { ...details, requestingUrl: 'https://evil.example/' }), false);
  let granted = false;
  session.request(null, 'clipboard-sanitized-write', value => { granted = value; }, details);
  assert.equal(granted, true);
  for (const url of ['https://evil.example/', 'file:///tmp/x', 'https://ltools.asia/maoyan/']) {
    let prevented = false;
    win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
  }
  let prevented = false;
  win.webContents.emit('will-redirect', { preventDefault() { prevented = true; } }, 'https://ltools.asia/maoyan/claim?client=desktop');
  assert.equal(prevented, false);
  assert.deepEqual(win.popup(), { action: 'deny' });
});
