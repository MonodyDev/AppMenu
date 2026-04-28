const Gio = imports.gi.Gio;

var REGISTRAR_BUS_NAME = "com.canonical.AppMenu.Registrar";
var REGISTRAR_OBJECT_PATH = "/com/canonical/AppMenu/Registrar";
var DBUS_BUS_NAME = "org.freedesktop.DBus";
var DBUS_OBJECT_PATH = "/org/freedesktop/DBus";

var REGISTRAR_IFACE = `
<node>
    <interface name="com.canonical.AppMenu.Registrar">
        <method name="GetMenuForWindow">
            <arg type="u" name="windowId" direction="in"/>
            <arg type="s" name="service" direction="out"/>
            <arg type="o" name="path" direction="out"/>
        </method>
        <method name="GetMenus">
            <arg type="a(uso)" name="menus" direction="out"/>
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

var REGISTRAR_SERVER_IFACE = `
<node>
    <interface name="com.canonical.AppMenu.Registrar">
        <method name="RegisterWindow">
            <arg type="u" name="windowId" direction="in"/>
            <arg type="o" name="menuObjectPath" direction="in"/>
        </method>
        <method name="UnregisterWindow">
            <arg type="u" name="windowId" direction="in"/>
        </method>
        <method name="GetMenuForWindow">
            <arg type="u" name="windowId" direction="in"/>
            <arg type="s" name="service" direction="out"/>
            <arg type="o" name="menuObjectPath" direction="out"/>
        </method>
        <method name="GetMenus">
            <arg type="a(uso)" name="menus" direction="out"/>
        </method>
        <signal name="WindowRegistered">
            <arg type="u" name="windowId"/>
            <arg type="s" name="service"/>
            <arg type="o" name="menuObjectPath"/>
        </signal>
        <signal name="WindowUnregistered">
            <arg type="u" name="windowId"/>
        </signal>
    </interface>
</node>`;

var DBUS_IFACE = `
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

var GTK_MENUS_IFACE = `
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

var GTK_ACTIONS_IFACE = `
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

var DBUS_MENU_IFACE = `
<node>
    <interface name="com.canonical.dbusmenu">
        <method name="GetLayout">
            <arg type="i" name="parentId" direction="in"/>
            <arg type="i" name="recursionDepth" direction="in"/>
            <arg type="as" name="propertyNames" direction="in"/>
            <arg type="u" name="revision" direction="out"/>
            <arg type="(ia{sv}av)" name="layout" direction="out"/>
        </method>
        <method name="GetGroupProperties">
            <arg type="ai" name="ids" direction="in"/>
            <arg type="as" name="propertyNames" direction="in"/>
            <arg type="a(ia{sv})" name="properties" direction="out"/>
        </method>
        <method name="Event">
            <arg type="i" name="id" direction="in"/>
            <arg type="s" name="eventId" direction="in"/>
            <arg type="v" name="data" direction="in"/>
            <arg type="u" name="timestamp" direction="in"/>
        </method>
        <method name="AboutToShow">
            <arg type="i" name="id" direction="in"/>
            <arg type="b" name="needUpdate" direction="out"/>
        </method>
        <signal name="ItemsPropertiesUpdated">
            <arg type="a(ia{sv})" name="updatedProps"/>
            <arg type="a(ias)" name="removedProps"/>
        </signal>
        <signal name="LayoutUpdated">
            <arg type="u" name="revision"/>
            <arg type="i" name="parent"/>
        </signal>
        <signal name="ItemActivationRequested">
            <arg type="i" name="id"/>
            <arg type="u" name="timestamp"/>
        </signal>
    </interface>
</node>`;

var RegistrarProxy = Gio.DBusProxy.makeProxyWrapper(REGISTRAR_IFACE);
var DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE);
var GtkMenusProxy = Gio.DBusProxy.makeProxyWrapper(GTK_MENUS_IFACE);
var GtkActionsProxy = Gio.DBusProxy.makeProxyWrapper(GTK_ACTIONS_IFACE);
var DBusMenuProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_MENU_IFACE);

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

  return label
    .replace(/__/g, "\u0000")
    .replace(/_([^_])/g, "$1")
    .replace(/\u0000/g, "_");
}

function actionNameFromDetailed(action) {
  if (!action) {
    return null;
  }

  let actionName = action;
  let dot = actionName.indexOf(".");
  if (dot >= 0) {
    actionName = actionName.slice(dot + 1);
  }

  let targetIndex = actionName.indexOf("::");
  if (targetIndex >= 0) {
    actionName = actionName.slice(0, targetIndex);
  }

  return actionName;
}

function actionGroupFromDetailed(action) {
  if (!action) {
    return null;
  }

  let dot = action.indexOf(".");
  return dot >= 0 ? action.slice(0, dot) : null;
}
