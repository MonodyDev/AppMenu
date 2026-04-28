const Applet = imports.ui.applet;
const ByteArray = imports.byteArray;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const PopupMenu = imports.ui.popupMenu;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;
const WindowMenu = imports.ui.windowMenu;

const UUID = "AppMenu@n0va";
const AppletDir = imports.ui.appletManager.appletMeta[UUID].path;
imports.searchPath.unshift(AppletDir);

const Utils = imports.utils;
const Registrar = imports.registrar;
const MenuWidgets = imports.menuWidgets;
const CanonicalBackend = imports.canonicalBackend;
const GtkBackend = imports.gtkBackend;

class GlobalAppMenuApplet extends Applet.TextApplet {
  constructor(orientation, panelHeight, instanceId) {
    super(orientation, panelHeight, instanceId);

    this._allowedLayout = Applet.AllowedLayout.HORIZONTAL;

    this._signals = new SignalManager.SignalManager(null);
    this._dbus = null;
    this._dbusNameOwnerChangedId = 0;
    this._registrar = null;
    this._windowRegisteredId = 0;
    this._windowUnregisteredId = 0;
    this._backend = null;
    this._buttonViews = [];
    this._refreshSerial = 0;
    this._syncRetryId = 0;
    this._currentAppName = "App";
    this._currentAppInfo = null;
    this._currentMetaWindow = null;
    this._windowMenuManager = null;

    this._menuButtonsBox = new St.BoxLayout({
      style_class: "appmenu-container",
      vertical: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.actor.insert_child_at_index(this._menuButtonsBox, 0);
    this.actor.reactive = false;
    this.actor.track_hover = false;

    this.set_applet_tooltip("Global application menu");
    this._signals.connect(
      global.display,
      "notify::focus-window",
      this._syncToFocus,
      this,
    );

    this._builtinRegistrar = new Registrar.BuiltinRegistrar();
    this._initBusWatcher();
  }

  get orientation() {
    return this._orientation;
  }

  _initBusWatcher() {
    this._dbus = new Utils.DBusProxy(
      Gio.DBus.session,
      Utils.DBUS_BUS_NAME,
      Utils.DBUS_OBJECT_PATH,
      Lang.bind(this, function (proxy, error) {
        if (error) {
          global.logWarning("Failed to watch DBus names: " + error.message);
          return;
        }

        this._dbusNameOwnerChangedId = this._dbus.connectSignal(
          "NameOwnerChanged",
          Lang.bind(this, this._onNameOwnerChanged),
        );

        this._ensureRegistrar();
      }),
    );
  }

  _ensureRegistrar() {
    if (!this._dbus) {
      return;
    }

    this._dbus.NameHasOwnerRemote(
      Utils.REGISTRAR_BUS_NAME,
      Lang.bind(this, function (result, error) {
        if (error) {
          global.logWarning(
            "Failed to check AppMenu registrar ownership: " + error.message,
          );
          return;
        }

        if (result[0]) {
          if (!this._registrar) {
            this._initRegistrar();
          } else {
            this._syncToFocus();
          }
        } else if (this._registrar) {
          this._clearRegistrar();
        }
      }),
    );
  }

  _initRegistrar() {
    this._registrar = new Utils.RegistrarProxy(
      Gio.DBus.session,
      Utils.REGISTRAR_BUS_NAME,
      Utils.REGISTRAR_OBJECT_PATH,
      Lang.bind(this, function (proxy, error) {
        if (error) {
          global.logWarning(
            "AppMenu registrar is unavailable: " + error.message,
          );
          this._clearRegistrar();
          return;
        }

        this._windowRegisteredId = this._registrar.connectSignal(
          "WindowRegistered",
          () => this._syncToFocus(),
        );
        this._windowUnregisteredId = this._registrar.connectSignal(
          "WindowUnregistered",
          () => this._syncToFocus(),
        );

        this._syncToFocus();
      }),
    );
  }

  _onNameOwnerChanged(proxy, sender, params) {
    if (params[0] === Utils.REGISTRAR_BUS_NAME) {
      this._ensureRegistrar();
    }
  }

  _syncToFocus() {
    if (this._syncRetryId) {
      GLib.source_remove(this._syncRetryId);
      this._syncRetryId = 0;
    }

    let metaWindow = global.display.focus_window;
    this._updateTooltip(metaWindow);

    if (!metaWindow) {
      this._clearBackend();
      this.set_applet_label("");
      return;
    }

    if (!this._registrar) {
      let source = this._resolveGtkSource(metaWindow);
      if (source) {
        this._setBackend(source);
        return;
      }

      this._syncRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        this._syncRetryId = 0;
        this._syncToFocusRetry(metaWindow);
        return GLib.SOURCE_REMOVE;
      });
      this._clearBackend();
      this._setStatusToAppName();
      return;
    }

    let windowId = 0;
    try {
      windowId = metaWindow.get_xwindow();
    } catch (e) {
      global.logWarning("Failed to read X11 window id: " + e.message);
    }

    if (!windowId) {
      this._clearBackend();
      this._setStatusToAppName();
      return;
    }

    let serial = ++this._refreshSerial;
    this._registrar.GetMenuForWindowRemote(
      windowId,
      Lang.bind(this, function (result, error) {
        if (serial !== this._refreshSerial) {
          return;
        }

        if (error) {
          global.logWarning(
            "Failed to query AppMenu registrar: " + error.message,
          );
          this._clearBackend();
          this._setStatusToAppName();
          return;
        }

        let busName = result[0];
        let objectPath = result[1];

        if (busName && objectPath && objectPath !== "/") {
          this._setBackend({
            type: "canonical",
            busName,
            objectPath,
          });
          return;
        }

        let source = this._resolveGtkSource(metaWindow);
        if (source) {
          this._setBackend(source);
          return;
        }

        this._syncRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
          this._syncRetryId = 0;
          this._syncToFocusRetry(metaWindow);
          return GLib.SOURCE_REMOVE;
        });
        this._clearBackend();
        this._setStatusToAppName();
      }),
    );
  }

  _syncToFocusRetry(originalWindow) {
    let currentWindow = global.display.focus_window;
    if (currentWindow === originalWindow) {
      this._syncToFocus();
    }
  }

  _resolveGtkSource(metaWindow) {
    let windowId = 0;

    try {
      windowId = metaWindow.get_xwindow();
    } catch (e) {
      return null;
    }

    if (!windowId) {
      return null;
    }

    let windowHex = "0x" + windowId.toString(16);

    try {
      let [ok, stdout] = GLib.spawn_sync(
        null,
        [
          "xprop",
          "-id",
          windowHex,
          "_GTK_UNIQUE_BUS_NAME",
          "_GTK_APP_MENU_OBJECT_PATH",
          "_GTK_MENUBAR_OBJECT_PATH",
          "_GTK_APPLICATION_OBJECT_PATH",
          "_GTK_WINDOW_OBJECT_PATH",
          "_UNITY_OBJECT_PATH",
        ],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null,
      );

      if (!ok) {
        return null;
      }

      let text = ByteArray.toString(stdout);
      let busNameMatch = text.match(
        /_GTK_UNIQUE_BUS_NAME\(UTF8_STRING\) = "([^"]+)"/,
      );
      let appMenuPathMatch = text.match(
        /_GTK_APP_MENU_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/,
      );
      let objectPathMatch = text.match(
        /_GTK_MENUBAR_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/,
      );
      let applicationPathMatch = text.match(
        /_GTK_APPLICATION_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/,
      );
      let windowPathMatch = text.match(
        /_GTK_WINDOW_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/,
      );
      let unityPathMatch = text.match(
        /_UNITY_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/,
      );

      let menuObjectPath = objectPathMatch
        ? objectPathMatch[1]
        : appMenuPathMatch
          ? appMenuPathMatch[1]
          : null;

      if (!busNameMatch || !menuObjectPath) {
        return null;
      }

      return {
        type: "gtk",
        busName: busNameMatch[1],
        objectPath: menuObjectPath,
        appMenuObjectPath: appMenuPathMatch ? appMenuPathMatch[1] : null,
        menubarObjectPath: objectPathMatch ? objectPathMatch[1] : null,
        applicationObjectPath: applicationPathMatch
          ? applicationPathMatch[1]
          : null,
        windowObjectPath: windowPathMatch ? windowPathMatch[1] : null,
        unityObjectPath: unityPathMatch ? unityPathMatch[1] : null,
      };
    } catch (e) {
      global.logWarning("Failed to query GTK X11 properties: " + e.message);
      return null;
    }
  }

  _setBackend(source) {
    if (this._backend && this._backend.sameAs(source)) {
      return;
    }

    this._clearBackend();

    if (source.type === "gtk") {
      this._backend = new GtkBackend.GtkMenusBackend(this, source);
    } else {
      this._backend = new CanonicalBackend.CanonicalMenuBackend(
        this,
        source.busName,
        source.objectPath,
      );
    }

    this._backend.load();
  }

  _clearBackend() {
    if (this._backend) {
      this._backend.destroy();
      this._backend = null;
    }

    this._clearTopLevelEntries();
  }

  _setTopLevelEntries(entries) {
    this._clearTopLevelEntries();

    let appEntry = this._buildAppEntry();
    if (!entries.length && !appEntry) {
      this._setStatusToAppName();
      return;
    }

    this._hideStatusLabel();
    this._menuButtonsBox.show();

    if (appEntry) {
      let appButton = new MenuWidgets.PanelMenuButton(this, appEntry);
      this._buttonViews.push(appButton);
      this._menuButtonsBox.add_actor(appButton.actor);
    }

    for (let entry of entries) {
      let button = new MenuWidgets.PanelMenuButton(this, entry);
      this._buttonViews.push(button);
      this._menuButtonsBox.add_actor(button.actor);
    }
  }

  _clearTopLevelEntries() {
    while (this._buttonViews.length) {
      this._buttonViews.pop().destroy();
    }

    this._menuButtonsBox.hide();
  }

  _setStatus(message) {
    this._clearTopLevelEntries();
    this.set_applet_label(message);
    this._showStatusLabel();
  }

  _setStatusToAppName() {
    this._setTopLevelEntries([]);
  }

  _updateTooltip(metaWindow) {
    let tooltip = "Global application menu";
    let appName = "App";
    let appInfo = null;

    if (metaWindow) {
      let tracker = Cinnamon.WindowTracker.get_default();
      let app = tracker ? tracker.get_window_app(metaWindow) : null;
      appName = app ? app.get_name() : metaWindow.get_title() || appName;
      appInfo = app && app.get_app_info ? app.get_app_info() : null;
      tooltip = appName;
    }

    this._currentAppName = appName;
    this._currentAppInfo = appInfo;
    this._currentMetaWindow = metaWindow || null;
    this.set_applet_tooltip(tooltip);
  }

  _buildAppEntry() {
    let entry = {
      label: this._currentAppName || "App",
      styleClass: "appmenu-app-name",
    };

    let appInfo = this._currentAppInfo;
    if (!appInfo || !appInfo.list_actions) {
      if (this._currentMetaWindow) {
        entry.activate = () => this._showActualWindowMenuForCurrentWindow(true);
        entry.noHighlight = true;
      }
      return entry;
    }

    let actions;
    try {
      actions = appInfo.list_actions();
    } catch (e) {
      global.logWarning(
        "Failed to get actions for " +
          (this._currentAppName || "app") +
          ": " +
          e.message,
      );
      actions = null;
    }
    if (!actions || !actions.length) {
      if (this._currentMetaWindow) {
        entry.activate = () => this._showActualWindowMenuForCurrentWindow(true);
        entry.noHighlight = true;
      }
      return entry;
    }

    entry.buildMenu = (menu, button) => {
      menu.removeAll();

      for (let action of actions) {
        let label;
        try {
          label = appInfo.get_action_name(action);
        } catch (e) {
          continue;
        }
        if (!label) {
          continue;
        }

        let item = new PopupMenu.PopupMenuItem(label);
        item.connect("activate", () => {
          try {
            appInfo.launch_action(action, global.create_app_launch_context());
          } catch (e) {
            global.logWarning(
              'Failed to launch action "' + action + '": ' + e.message,
            );
          }
        });
        menu.addMenuItem(item);
      }

      if (this._currentMetaWindow) {
        if (menu.numMenuItems > 0) {
          menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        let windowItem = new PopupMenu.PopupMenuItem("Window");
        windowItem.connect("activate", () => {
          menu.close(true);
          this._showActualWindowMenu(button.actor);
        });
        menu.addMenuItem(windowItem);
      }
    };

    return entry;
  }

  _showActualWindowMenuForCurrentWindow(noHighlight) {
    if (!this._currentMetaWindow || !this._buttonViews.length) {
      return;
    }

    this._showActualWindowMenu(this._buttonViews[0].actor, noHighlight);
  }

  _showActualWindowMenu(sourceActor, noHighlight) {
    if (!this._currentMetaWindow || !sourceActor) {
      return;
    }

    if (!this._windowMenuManager) {
      this._windowMenuManager = new WindowMenu.WindowMenuManager();
    }

    if (!noHighlight) {
      sourceActor.change_style_pseudo_class("checked", true);
    }

    let [x, y] = sourceActor.get_transformed_position();
    let [width, height] = sourceActor.get_transformed_size();

    this._windowMenuManager.showWindowMenuForWindow(
      this._currentMetaWindow,
      Meta.WindowMenuType.WM,
      {
        x: Math.round(x),
        y: Math.round(y + height),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      },
    );

    let windowMenu = this._windowMenuManager.current_menu;
    if (!windowMenu) {
      if (!noHighlight) {
        sourceActor.change_style_pseudo_class("checked", false);
      }
      return;
    }

    let clearChecked = () => {
      if (!noHighlight && sourceActor && !sourceActor.is_finalized()) {
        sourceActor.change_style_pseudo_class("checked", false);
      }
    };

    let openStateId = windowMenu.connect("open-state-changed", (menu, open) => {
      if (!open) {
        clearChecked();
      }
    });

    let closedId = windowMenu.connect("menu-animated-closed", () => {
      clearChecked();
      if (openStateId) {
        windowMenu.disconnect(openStateId);
        openStateId = 0;
      }
      if (closedId) {
        windowMenu.disconnect(closedId);
        closedId = 0;
      }
    });
  }

  _hideStatusLabel() {
    if (this._layoutBin) {
      this._layoutBin.hide();
    }
    if (this._applet_label) {
      this._applet_label.hide();
    }
  }

  _showStatusLabel() {
    if (this._layoutBin) {
      this._layoutBin.show();
    }
    if (this._applet_label) {
      this._applet_label.show();
    }
  }

  on_applet_clicked() {}

  on_orientation_changed(orientation) {
    this._menuButtonsBox.vertical =
      orientation === St.Side.LEFT || orientation === St.Side.RIGHT;

    for (let button of this._buttonViews) {
      button.setOrientation(orientation);
    }
  }

  on_applet_removed_from_panel() {
    this._signals.disconnectAllSignals();
    this._clearRegistrar();

    if (this._syncRetryId) {
      GLib.source_remove(this._syncRetryId);
      this._syncRetryId = 0;
    }

    if (this._dbus) {
      if (this._dbusNameOwnerChangedId) {
        this._dbus.disconnectSignal(this._dbusNameOwnerChangedId);
        this._dbusNameOwnerChangedId = 0;
      }

      this._dbus = null;
    }

    if (this._builtinRegistrar) {
      this._builtinRegistrar.destroy();
      this._builtinRegistrar = null;
    }

    if (this._windowMenuManager) {
      this._windowMenuManager.destroy();
      this._windowMenuManager = null;
    }
  }

  _clearRegistrar() {
    this._clearBackend();

    if (this._registrar) {
      if (this._windowRegisteredId) {
        this._registrar.disconnectSignal(this._windowRegisteredId);
        this._windowRegisteredId = 0;
      }

      if (this._windowUnregisteredId) {
        this._registrar.disconnectSignal(this._windowUnregisteredId);
        this._windowUnregisteredId = 0;
      }

      this._registrar = null;
    }
  }
}

function main(metadata, orientation, panelHeight, instanceId) {
  try {
    return new GlobalAppMenuApplet(orientation, panelHeight, instanceId);
  } catch (e) {
    global.logError(e, UUID + " failed during main()");
    throw e;
  }
}
