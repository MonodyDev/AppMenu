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
const DBusMenu = imports.ui.dbusMenu;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;
const WindowMenu = imports.ui.windowMenu;

const REGISTRAR_BUS_NAME = "com.canonical.AppMenu.Registrar";
const REGISTRAR_OBJECT_PATH = "/com/canonical/AppMenu/Registrar";
const DBUS_BUS_NAME = "org.freedesktop.DBus";
const DBUS_OBJECT_PATH = "/org/freedesktop/DBus";

const REGISTRAR_IFACE = `
<node>
    <interface name="com.canonical.AppMenu.Registrar">
        <method name="GetMenuForWindow">
            <arg type="u" name="windowId" direction="in"/>
            <arg type="s" name="service" direction="out"/>
            <arg type="o" name="path" direction="out"/>
        </method>
        <signal name="WindowRegistered">
            <arg type="u" name="windowId"/>
            <arg type="s" name="service"/>
            <arg type="o" name="path"/>
        </signal>
        <signal name="WindowUnregistered">
            <arg type="u" name="windowId"/>
        </signal>
    </interface>
</node>`;

const DBUS_IFACE = `
<node>
    <interface name="org.freedesktop.DBus">
        <method name="NameHasOwner">
            <arg type="s" name="name" direction="in"/>
            <arg type="b" name="hasOwner" direction="out"/>
        </method>
        <signal name="NameOwnerChanged">
            <arg type="s" name="name"/>
            <arg type="s" name="oldOwner"/>
            <arg type="s" name="newOwner"/>
        </signal>
    </interface>
</node>`;

const GTK_MENUS_IFACE = `
<node>
    <interface name="org.gtk.Menus">
        <method name="Start">
            <arg type="au" name="groups" direction="in"/>
            <arg type="a(uuaa{sv})" name="content" direction="out"/>
        </method>
        <method name="End">
            <arg type="au" name="groups" direction="in"/>
        </method>
        <signal name="Changed"/>
    </interface>
</node>`;

const GTK_ACTIONS_IFACE = `
<node>
    <interface name="org.gtk.Actions">
        <method name="DescribeAll">
            <arg type="a{s(bgav)}" name="descriptions" direction="out"/>
        </method>
        <method name="Activate">
            <arg type="s" name="action_name" direction="in"/>
            <arg type="av" name="parameter" direction="in"/>
            <arg type="a{sv}" name="platform_data" direction="in"/>
        </method>
        <signal name="Changed">
            <arg type="as" name="removals"/>
            <arg type="a{sb}" name="enable_changes"/>
            <arg type="a{sv}" name="state_changes"/>
            <arg type="a{s(bgav)}" name="additions"/>
        </signal>
    </interface>
</node>`;

const RegistrarProxy = Gio.DBusProxy.makeProxyWrapper(REGISTRAR_IFACE);
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE);
const GtkMenusProxy = Gio.DBusProxy.makeProxyWrapper(GTK_MENUS_IFACE);
const GtkActionsProxy = Gio.DBusProxy.makeProxyWrapper(GTK_ACTIONS_IFACE);

function variantToValue(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (value.deep_unpack) {
        return value.deep_unpack();
    }

    return value;
}

function cleanMnemonic(label) {
    if (!label) {
        return "";
    }

    return label.replace(/__/g, "\u0000")
        .replace(/_([^_])/g, "$1")
        .replace(/\u0000/g, "_");
}

function actionNameFromDetailed(action) {
    if (!action) {
        return null;
    }

    let dot = action.indexOf(".");
    return dot >= 0 ? action.slice(dot + 1) : action;
}

class PanelMenuButton {
    constructor(applet, entry) {
        this.applet = applet;
        this.entry = entry;
        this.menu = null;
        let isInteractive = !!(entry.buildMenu || entry.activate);
        let trackHover = isInteractive && !entry.noHighlight;
        let styleClass = "applet-box appmenu-panel-button";
        if (entry.styleClass) {
            styleClass += " " + entry.styleClass;
        }

        this.actor = new St.BoxLayout({
            style_class: styleClass,
            reactive: isInteractive,
            can_focus: isInteractive,
            track_hover: trackHover,
            x_expand: false,
            vertical: false,
        });

        this.label = new St.Label({
            text: entry.label,
            style_class: "applet-label",
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_actor(this.label);

        if (entry.buildMenu) {
            this.menu = new PopupMenu.PopupMenu(this.actor, this.applet.orientation);
            Main.uiGroup.add_actor(this.menu.actor);
            this.menu.actor.hide();
            this.applet._menuManager.addMenu(this.menu);

            entry.buildMenu(this.menu, this);

            this._menuOpenId = this.menu.connect("open-state-changed", (menu, open) => {
                this.actor.change_style_pseudo_class("checked", open);
            });
        } else {
            this._menuOpenId = 0;
        }

        this._buttonReleaseId = this.actor.connect("button-release-event", () => {
            if (this.menu) {
                this._prepareMenuAlignment();
                this.menu.toggle();
            } else if (this.entry.activate) {
                this.entry.activate();
            }

            return Clutter.EVENT_STOP;
        });
    }

    setOrientation(orientation) {
        if (this.menu) {
            this.menu.setOrientation(orientation);
        }
    }

    _prepareMenuAlignment() {
        if (!this.menu) {
            return;
        }

        if (this.applet.orientation !== St.Side.TOP &&
            this.applet.orientation !== St.Side.BOTTOM) {
            return;
        }

        let [sourceX] = this.actor.get_transformed_position();
        let [, , natWidth] = this.menu.actor.get_preferred_size();
        if (!natWidth) {
            return;
        }

        this.menu.shiftToPosition(sourceX + natWidth / 2);
    }

    destroy() {
        if (this.menu) {
            if (this._menuOpenId) {
                this.menu.disconnect(this._menuOpenId);
                this._menuOpenId = 0;
            }

            this.menu.destroy();
            this.menu = null;
        }

        if (this.actor) {
            if (this._buttonReleaseId) {
                this.actor.disconnect(this._buttonReleaseId);
                this._buttonReleaseId = 0;
            }

            this.actor.destroy();
            this.actor = null;
        }
    }
}

class CanonicalMenuBackend {
    constructor(applet, busName, objectPath) {
        this.applet = applet;
        this.busName = busName;
        this.objectPath = objectPath;
        this.menuClient = null;
        this.menuFactory = null;
        this.root = null;
        this.rootSignalIds = [];
    }

    sameAs(source) {
        return source &&
            source.type === "canonical" &&
            source.busName === this.busName &&
            source.objectPath === this.objectPath;
    }

    load() {
        this.menuFactory = new PopupMenu.PopupMenuFactory();
        this.menuClient = new DBusMenu.DBusClient(this.busName, this.objectPath);
        this.root = this.menuClient.getRoot();

        this.rootSignalIds.push(this.root.connect("child-added", () => this._publish()));
        this.rootSignalIds.push(this.root.connect("child-removed", () => this._publish()));
        this.rootSignalIds.push(this.root.connect("child-moved", () => this._publish()));

        this._publish();
    }

    _publish() {
        if (!this.root) {
            return;
        }

        let entries = this.root.getChildren()
            .filter(item => item.isVisible())
            .map(item => ({
                label: cleanMnemonic(item.getLabel()),
                buildMenu: item.getChildrenIds().length > 0
                    ? menu => this.menuFactory._attachToMenu(menu, item)
                    : null,
                activate: item.getChildrenIds().length === 0
                    ? () => item.handleEvent("clicked")
                    : null,
            }))
            .filter(entry => entry.label.length > 0);

        this.applet._setTopLevelEntries(entries);
    }

    destroy() {
        if (this.root) {
            for (let id of this.rootSignalIds) {
                this.root.disconnect(id);
            }
        }

        this.rootSignalIds = [];
        this.root = null;

        if (this.menuClient) {
            try {
                this.menuClient.destroy();
            } catch (e) {
                global.logWarning("Failed to destroy DBusMenu client: " + e.message);
            }
            this.menuClient = null;
        }

        this.menuFactory = null;
    }
}

class GtkMenusBackend {
    constructor(applet, busName, objectPath) {
        this.applet = applet;
        this.busName = busName;
        this.objectPath = objectPath;
        this.menuProxy = null;
        this.actionsProxy = null;
        this.menuSignalId = 0;
        this.actionsSignalId = 0;
        this.reloadSerial = 0;
        this.startedGroups = [];
        this.groupMenus = {};
        this.actionDescriptions = {};
    }

    sameAs(source) {
        return source &&
            source.type === "gtk" &&
            source.busName === this.busName &&
            source.objectPath === this.objectPath;
    }

    load() {
        this.menuProxy = new GtkMenusProxy(
            Gio.DBus.session,
            this.busName,
            this.objectPath,
            Lang.bind(this, function (proxy, error) {
                if (error) {
                    global.logWarning("Failed to create GTK menu proxy: " + error.message);
                    this.applet._setStatus("Failed to read the GTK global menu.");
                    return;
                }

                this.menuSignalId = this.menuProxy.connectSignal("Changed", () => this.reload());

                this.actionsProxy = new GtkActionsProxy(
                    Gio.DBus.session,
                    this.busName,
                    this.objectPath,
                    Lang.bind(this, function (actionsProxy, actionsError) {
                        if (actionsError) {
                            global.logWarning("Failed to create GTK actions proxy: " + actionsError.message);
                            this.applet._setStatus("Failed to read the GTK action group.");
                            return;
                        }

                        this.actionsSignalId = this.actionsProxy.connectSignal("Changed", () => this.reload());
                        this.reload();
                    })
                );
            })
        );
    }

    reload() {
        if (!this.menuProxy || !this.actionsProxy) {
            return;
        }

        let serial = ++this.reloadSerial;
        this.groupMenus = {};

        if (this.startedGroups.length) {
            try {
                this.menuProxy.EndRemote(this.startedGroups, () => { });
            } catch (e) {
                global.logWarning("Failed to end previous GTK menu groups: " + e.message);
            }
            this.startedGroups = [];
        }

        this.actionsProxy.DescribeAllRemote(Lang.bind(this, function (result, error) {
            if (serial !== this.reloadSerial) {
                return;
            }

            if (error) {
                global.logWarning("Failed to read GTK actions: " + error.message);
                this.applet._setStatus("Failed to query GTK actions.");
                return;
            }

            this.actionDescriptions = result[0] || {};
            this._loadGroups(serial, [0], {});
        }));
    }

    _loadGroups(serial, groupIds, seenGroups) {
        if (!groupIds.length) {
            this._publish(serial);
            return;
        }

        this.startedGroups = Array.from(new Set(this.startedGroups.concat(groupIds)));

        this.menuProxy.StartRemote(groupIds, Lang.bind(this, function (result, error) {
            if (serial !== this.reloadSerial) {
                return;
            }

            if (error) {
                global.logWarning("Failed to read GTK menu groups: " + error.message);
                this.applet._setStatus("Failed to query GTK menu groups.");
                return;
            }

            let nextGroups = [];

            for (let [groupId, menuId, items] of result[0]) {
                this.groupMenus[`${groupId}:${menuId}`] = items;
                seenGroups[groupId] = true;

                for (let item of items) {
                    for (let key of [":section", ":submenu"]) {
                        if (!item[key]) {
                            continue;
                        }

                        let [childGroupId] = variantToValue(item[key]);
                        if (!seenGroups[childGroupId] && !nextGroups.includes(childGroupId)) {
                            nextGroups.push(childGroupId);
                        }
                    }
                }
            }

            this._loadGroups(serial, nextGroups, seenGroups);
        }));
    }

    _publish(serial) {
        if (serial !== this.reloadSerial) {
            return;
        }

        let rootRef = this._resolveRootRef([0, 0]);
        let items = this._getMenuItems(rootRef);
        let entries = [];

        for (let item of items) {
            let label = cleanMnemonic(variantToValue(item.label));
            if (!label) {
                continue;
            }

            if (item[":submenu"]) {
                let submenuRef = variantToValue(item[":submenu"]);
                entries.push({
                    label,
                    buildMenu: menu => {
                        menu.removeAll();
                        this._appendMenuRef(menu, submenuRef, false);
                    },
                });
                continue;
            }

            let detailedAction = variantToValue(item.action);
            let actionName = actionNameFromDetailed(detailedAction);
            let target = item.target || null;

            entries.push({
                label,
                activate: actionName ? () => this._activateAction(actionName, target) : null,
            });
        }

        this.applet._setTopLevelEntries(entries);
    }

    _resolveRootRef(ref) {
        let current = ref;

        while (true) {
            let items = this._getMenuItems(current);
            if (items.length !== 1 || !items[0][":section"]) {
                return current;
            }

            current = variantToValue(items[0][":section"]);
        }
    }

    _getMenuItems(ref) {
        return this.groupMenus[`${ref[0]}:${ref[1]}`] || [];
    }

    _appendMenuRef(menu, ref, insideSection) {
        let items = this._getMenuItems(ref);
        let seenContent = false;

        for (let item of items) {
            if (item[":section"]) {
                let sectionRef = variantToValue(item[":section"]);
                let sectionCount = this._countRenderableItems(sectionRef);
                if (sectionCount === 0) {
                    continue;
                }

                if (!insideSection && seenContent) {
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                }

                this._appendMenuRef(menu, sectionRef, true);
                seenContent = true;
                continue;
            }

            let menuItem = this._createMenuItem(item);
            if (!menuItem) {
                continue;
            }

            menu.addMenuItem(menuItem);
            seenContent = true;
        }
    }

    _countRenderableItems(ref) {
        let items = this._getMenuItems(ref);
        let count = 0;

        for (let item of items) {
            if (item[":section"]) {
                count += this._countRenderableItems(variantToValue(item[":section"]));
            } else {
                count++;
            }
        }

        return count;
    }

    _createMenuItem(item) {
        let label = cleanMnemonic(variantToValue(item.label));
        if (!label) {
            return null;
        }

        if (item[":submenu"]) {
            let submenu = new PopupMenu.PopupSubMenuMenuItem(label);
            let submenuRef = variantToValue(item[":submenu"]);
            this._appendMenuRef(submenu.menu, submenuRef, false);
            return submenu;
        }

        let detailedAction = variantToValue(item.action);
        let actionName = actionNameFromDetailed(detailedAction);
        let actionInfo = actionName ? this.actionDescriptions[actionName] : null;
        let enabled = actionInfo ? !!actionInfo[0] : true;
        let accel = cleanMnemonic(variantToValue(item.accel));
        let target = item.target || null;
        let state = actionInfo && actionInfo.length > 2 ? actionInfo[2] : [];

        let menuItem = new PopupMenu.PopupIndicatorMenuItem(label, {
            reactive: enabled,
            sensitive: enabled,
        });

        if (accel) {
            menuItem.setAccel(accel);
        }

        if (state.length > 0) {
            let currentState = state[0];
            if (target) {
                let selected = variantToValue(currentState) === variantToValue(target);
                menuItem.setOrnament(PopupMenu.OrnamentType.DOT, selected);
            } else if (currentState.get_type_string && currentState.get_type_string() === "b") {
                menuItem.setOrnament(PopupMenu.OrnamentType.CHECK, currentState.deep_unpack());
            }
        }

        if (actionName) {
            menuItem.connect("activate", () => this._activateAction(actionName, target));
        }

        return menuItem;
    }

    _activateAction(actionName, target) {
        if (!this.actionsProxy) {
            return;
        }

        let parameters = target ? [target] : [];
        this.actionsProxy.ActivateRemote(actionName, parameters, {}, (result, error) => {
            if (error) {
                global.logWarning(`Failed to activate GTK action "${actionName}": ${error.message}`);
                return;
            }

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.reload();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    destroy() {
        if (this.menuProxy) {
            if (this.menuSignalId) {
                this.menuProxy.disconnectSignal(this.menuSignalId);
                this.menuSignalId = 0;
            }

            if (this.startedGroups.length) {
                try {
                    this.menuProxy.EndRemote(this.startedGroups, () => { });
                } catch (e) {
                    global.logWarning("Failed to end GTK menu groups: " + e.message);
                }
            }
        }

        if (this.actionsProxy && this.actionsSignalId) {
            this.actionsProxy.disconnectSignal(this.actionsSignalId);
            this.actionsSignalId = 0;
        }

        this.menuProxy = null;
        this.actionsProxy = null;
        this.startedGroups = [];
        this.groupMenus = {};
        this.actionDescriptions = {};
    }
}

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
        this._currentAppName = "App";
        this._currentAppInfo = null;
        this._currentMetaWindow = null;
        this._windowMenuManager = new WindowMenu.WindowMenuManager();

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
        this._signals.connect(global.display, "notify::focus-window", this._syncToFocus, this);

        this._initBusWatcher();
        this._setStatus("Waiting for the AppMenu registrar.");
    }

    get orientation() {
        return this._orientation;
    }

    _initBusWatcher() {
        this._dbus = new DBusProxy(
            Gio.DBus.session,
            DBUS_BUS_NAME,
            DBUS_OBJECT_PATH,
            Lang.bind(this, function (proxy, error) {
                if (error) {
                    global.logWarning("Failed to watch DBus names: " + error.message);
                    this._setStatus("Failed to watch the AppMenu registrar on DBus.");
                    return;
                }

                this._dbusNameOwnerChangedId = this._dbus.connectSignal(
                    "NameOwnerChanged",
                    Lang.bind(this, this._onNameOwnerChanged)
                );

                this._ensureRegistrar();
            })
        );
    }

    _ensureRegistrar() {
        if (!this._dbus) {
            return;
        }

        this._dbus.NameHasOwnerRemote(REGISTRAR_BUS_NAME, Lang.bind(this, function (result, error) {
            if (error) {
                global.logWarning("Failed to check AppMenu registrar ownership: " + error.message);
                this._setStatus("Failed to query the AppMenu registrar state.");
                return;
            }

            if (result[0]) {
                if (!this._registrar) {
                    this._initRegistrar();
                } else {
                    this._syncToFocus();
                }
            } else {
                this._clearRegistrar();
                this._setStatus("AppMenu registrar is unavailable.");
            }
        }));
    }

    _initRegistrar() {
        this._registrar = new RegistrarProxy(
            Gio.DBus.session,
            REGISTRAR_BUS_NAME,
            REGISTRAR_OBJECT_PATH,
            Lang.bind(this, function (proxy, error) {
                if (error) {
                    global.logWarning("AppMenu registrar is unavailable: " + error.message);
                    this._clearRegistrar();
                    this._setStatus("AppMenu registrar is unavailable.");
                    return;
                }

                this._windowRegisteredId = this._registrar.connectSignal("WindowRegistered", () => this._syncToFocus());
                this._windowUnregisteredId = this._registrar.connectSignal("WindowUnregistered", () => this._syncToFocus());

                this._syncToFocus();
            })
        );
    }

    _onNameOwnerChanged(proxy, sender, params) {
        if (params[0] === REGISTRAR_BUS_NAME) {
            this._ensureRegistrar();
        }
    }

    _syncToFocus() {
        let metaWindow = global.display.focus_window;
        this._updateTooltip(metaWindow);

        if (!metaWindow) {
            this._clearBackend();
            this._setStatus("No focused window.");
            return;
        }

        let source = this._resolveGtkSource(metaWindow);
        if (source) {
            this._setBackend(source);
            return;
        }

        if (!this._registrar) {
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
        this._registrar.GetMenuForWindowRemote(windowId, Lang.bind(this, function (result, error) {
            if (serial !== this._refreshSerial) {
                return;
            }

            if (error) {
                global.logWarning("Failed to query AppMenu registrar: " + error.message);
                this._clearBackend();
                this._setStatusToAppName();
                return;
            }

            let busName = result[0];
            let objectPath = result[1];

            if (!busName || !objectPath || objectPath === "/") {
                this._clearBackend();
                this._setStatusToAppName();
                return;
            }

            this._setBackend({
                type: "canonical",
                busName,
                objectPath,
            });
        }));
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
                ["xprop", "-id", windowHex, "_GTK_UNIQUE_BUS_NAME", "_GTK_MENUBAR_OBJECT_PATH"],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            if (!ok) {
                return null;
            }

            let text = ByteArray.toString(stdout);
            let busNameMatch = text.match(/_GTK_UNIQUE_BUS_NAME\(UTF8_STRING\) = "([^"]+)"/);
            let objectPathMatch = text.match(/_GTK_MENUBAR_OBJECT_PATH\(UTF8_STRING\) = "([^"]+)"/);

            if (!busNameMatch || !objectPathMatch) {
                return null;
            }

            return {
                type: "gtk",
                busName: busNameMatch[1],
                objectPath: objectPathMatch[1],
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
            this._backend = new GtkMenusBackend(this, source.busName, source.objectPath);
        } else {
            this._backend = new CanonicalMenuBackend(this, source.busName, source.objectPath);
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
            let appButton = new PanelMenuButton(this, appEntry);
            this._buttonViews.push(appButton);
            this._menuButtonsBox.add_actor(appButton.actor);
        }

        for (let entry of entries) {
            let button = new PanelMenuButton(this, entry);
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
            appName = app ? app.get_name() : (metaWindow.get_title() || appName);
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

        let actions = appInfo.list_actions();
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
                let label = appInfo.get_action_name(action);
                if (!label) {
                    continue;
                }

                let item = new PopupMenu.PopupMenuItem(label);
                item.connect("activate", () => {
                    appInfo.launch_action(action, global.create_app_launch_context());
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
            }
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

    on_applet_clicked() {
    }

    on_orientation_changed(orientation) {
        this._menuButtonsBox.vertical = orientation === St.Side.LEFT || orientation === St.Side.RIGHT;

        for (let button of this._buttonViews) {
            button.setOrientation(orientation);
        }
    }

    on_applet_removed_from_panel() {
        this._signals.disconnectAllSignals();
        this._clearRegistrar();

        if (this._dbus) {
            if (this._dbusNameOwnerChangedId) {
                this._dbus.disconnectSignal(this._dbusNameOwnerChangedId);
                this._dbusNameOwnerChangedId = 0;
            }

            this._dbus = null;
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
    return new GlobalAppMenuApplet(orientation, panelHeight, instanceId);
}
