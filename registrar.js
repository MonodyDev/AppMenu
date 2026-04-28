const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Utils = imports.utils;

var BuiltinRegistrar = class BuiltinRegistrar {
  constructor() {
    this._windows = {};
    this._senderWindows = {};
    this._senderWatches = {};

    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
      Utils.REGISTRAR_SERVER_IFACE,
      this,
    );
    this._dbusImpl.export(Gio.DBus.session, Utils.REGISTRAR_OBJECT_PATH);

    this._ownerId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      Utils.REGISTRAR_BUS_NAME,
      Gio.BusNameOwnerFlags.REPLACE,
      null,
      null,
    );
  }

  RegisterWindowAsync(params, invocation) {
    let [windowId, menuObjectPath] = params;
    let sender = invocation.get_sender();

    this._windows[windowId] = {
      service: sender,
      path: menuObjectPath,
    };

    if (!this._senderWindows[sender]) {
      this._senderWindows[sender] = [];
      this._senderWatches[sender] = Gio.bus_watch_name_on_connection(
        Gio.DBus.session,
        sender,
        Gio.BusNameWatcherFlags.NONE,
        null,
        () => this._onSenderVanished(sender),
      );
    }

    if (!this._senderWindows[sender].includes(windowId)) {
      this._senderWindows[sender].push(windowId);
    }

    this._dbusImpl.emit_signal(
      "WindowRegistered",
      new GLib.Variant("(uso)", [windowId, sender, menuObjectPath]),
    );

    invocation.return_value(null);
  }

  UnregisterWindowAsync(params, invocation) {
    let [windowId] = params;
    let entry = this._windows[windowId];
    if (entry) {
      let sender = entry.service;
      delete this._windows[windowId];

      if (this._senderWindows[sender]) {
        let idx = this._senderWindows[sender].indexOf(windowId);
        if (idx >= 0) {
          this._senderWindows[sender].splice(idx, 1);
        }

        if (this._senderWindows[sender].length === 0) {
          this._unwatchSender(sender);
        }
      }

      this._dbusImpl.emit_signal(
        "WindowUnregistered",
        new GLib.Variant("(u)", [windowId]),
      );
    }

    invocation.return_value(null);
  }

  GetMenuForWindowAsync(params, invocation) {
    let [windowId] = params;
    let entry = this._windows[windowId];
    if (entry) {
      invocation.return_value(
        new GLib.Variant("(so)", [entry.service, entry.path]),
      );
    } else {
      invocation.return_value(new GLib.Variant("(so)", ["", "/"]));
    }
  }

  GetMenusAsync(params, invocation) {
    let menus = [];

    for (let windowId in this._windows) {
      let entry = this._windows[windowId];
      if (!entry) {
        continue;
      }

      menus.push([
        Number(windowId),
        entry.service,
        entry.path,
      ]);
    }

    invocation.return_value(
      new GLib.Variant("(a(uso))", [menus]),
    );
  }

  _onSenderVanished(sender) {
    let windowIds = this._senderWindows[sender] || [];
    for (let windowId of windowIds) {
      delete this._windows[windowId];
      this._dbusImpl.emit_signal(
        "WindowUnregistered",
        new GLib.Variant("(u)", [windowId]),
      );
    }

    this._unwatchSender(sender);
  }

  _unwatchSender(sender) {
    if (this._senderWatches[sender]) {
      Gio.bus_unwatch_name(this._senderWatches[sender]);
      delete this._senderWatches[sender];
    }

    delete this._senderWindows[sender];
  }

  destroy() {
    for (let sender in this._senderWatches) {
      Gio.bus_unwatch_name(this._senderWatches[sender]);
    }

    this._senderWatches = {};
    this._senderWindows = {};
    this._windows = {};

    if (this._ownerId) {
      Gio.bus_unown_name(this._ownerId);
      this._ownerId = 0;
    }

    this._dbusImpl.unexport();
  }
};
