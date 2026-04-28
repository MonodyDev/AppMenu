const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const PopupMenu = imports.ui.popupMenu;

const Utils = imports.utils;
const MenuWidgets = imports.menuWidgets;

function _variantMapToObject(map) {
  let out = {};
  for (let key in map) {
    out[key] = Utils.variantToValue(map[key]);
  }
  return out;
}

function _normalizeNode(layoutNode) {
  layoutNode = Utils.variantToValue(layoutNode);
  let [id, properties, children] = layoutNode;
  return {
    id,
    properties: _variantMapToObject(properties),
    children: Utils.variantToValue(children).map(_normalizeNode),
  };
}

function _isVisible(node) {
  return node.properties.visible !== false;
}

function _labelFor(node) {
  return Utils.cleanMnemonic(node.properties.label || "");
}

function _isSeparator(node) {
  return node.properties.type === "separator";
}

function _hasChildren(node) {
  return node.properties["children-display"] === "submenu" ||
    !!(node.children && node.children.length);
}

function _isToggled(value) {
  value = Utils.variantToValue(value);

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    let normalized = value.toLowerCase();
    return normalized !== "" &&
      normalized !== "0" &&
      normalized !== "false" &&
      normalized !== "off" &&
      normalized !== "unchecked";
  }

  return !!value;
}

function _makeOrnamentPassive(menuItem) {
  if (!menuItem || !menuItem._ornament) {
    return;
  }

  menuItem._ornament.reactive = false;
  menuItem._ornament.can_focus = false;
  menuItem._ornament.track_hover = false;

  if (menuItem._ornament.child) {
    menuItem._ornament.child.reactive = false;
    menuItem._ornament.child.can_focus = false;
    menuItem._ornament.child.track_hover = false;
  }
}

var CanonicalMenuBackend = class CanonicalMenuBackend {
  constructor(applet, busName, objectPath) {
    this.applet = applet;
    this.busName = busName;
    this.objectPath = objectPath;
    this.proxy = null;
    this.layoutSignalId = 0;
    this.propertiesSignalId = 0;
    this.reloadSerial = 0;
    this.root = null;
    this._refreshId = 0;
    this._pendingReload = false;
    this._openMenuCount = 0;
  }

  sameAs(source) {
    return (
      source &&
      source.type === "canonical" &&
      source.busName === this.busName &&
      source.objectPath === this.objectPath
    );
  }

  load() {
    this.proxy = new Utils.DBusMenuProxy(
      Gio.DBus.session,
      this.busName,
      this.objectPath,
      (proxy, error) => {
        if (error) {
          global.logWarning(
            "Failed to create canonical menu proxy: " + error.message,
          );
          return;
        }

        this.layoutSignalId = this.proxy.connectSignal("LayoutUpdated", () =>
          this._requestReload(80),
        );
        this.propertiesSignalId = this.proxy.connectSignal(
          "ItemsPropertiesUpdated",
          () => this._requestReload(80),
        );

        this.reload();
      },
    );
  }

  _scheduleReload(delay) {
    if (this._refreshId) {
      GLib.source_remove(this._refreshId);
      this._refreshId = 0;
    }

    this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this._refreshId = 0;
      this.reload();
      return GLib.SOURCE_REMOVE;
    });
  }

  _requestReload(delay) {
    if (this._openMenuCount > 0) {
      this._pendingReload = true;
      return;
    }

    this._scheduleReload(delay);
  }

  _beginMenuOpen() {
    this._openMenuCount++;
  }

  _endMenuOpen() {
    if (this._openMenuCount > 0) {
      this._openMenuCount--;
    }
  }

  reload() {
    if (!this.proxy) {
      return;
    }

    let serial = ++this.reloadSerial;
    this.proxy.GetLayoutRemote(
      0,
      -1,
      [],
      (result, error) => {
        if (serial !== this.reloadSerial) {
          return;
        }

        if (error) {
          global.logWarning(
            "Failed to read canonical menu layout: " + error.message,
          );
          return;
        }

        let layoutNode = result && result[1] ? result[1] : null;
        if (Array.isArray(layoutNode) && layoutNode.length === 1 &&
          Array.isArray(layoutNode[0])) {
          layoutNode = layoutNode[0];
        }
        if (!layoutNode || !Array.isArray(layoutNode)) {
          global.logWarning("Failed to read canonical menu layout: unexpected layout payload");
          return;
        }

        this.root = _normalizeNode(layoutNode);
        this._publish();
      },
    );
  }

  _publish() {
    if (!this.root) {
      return;
    }

    let root = this.root;
    let children = (root.children || []).filter(_isVisible);
    let entries = [];

    for (let node of children) {
      let label = _labelFor(node);
      if (!label) {
        continue;
      }

      entries.push({
        label,
        buildMenu: _hasChildren(node)
          ? (menu) => {
            menu.removeAll();
            this._appendNodes(menu, node.children || []);
          }
          : null,
        beforeOpen: _hasChildren(node)
          ? (menu) => this._prepareOpen(node.id, menu, () => node.children || [])
          : null,
        onOpen: _hasChildren(node)
          ? () => this._beginMenuOpen()
          : null,
        onClose: _hasChildren(node)
          ? () => {
            this._endMenuOpen();
            this._sendEvent(node.id, PopupMenu.FactoryEventTypes.closed);
            this.flushPendingReload();
          }
          : null,
        activate: !_hasChildren(node)
          ? () => this._sendEvent(node.id, "clicked")
          : null,
      });
    }

    this.applet._setTopLevelEntries(entries);
  }

  _prepareOpen(id, menu, getChildren) {
    this._sendEvent(id, PopupMenu.FactoryEventTypes.opened);
    this.proxy.AboutToShowRemote(id, (result, error) => {
      if (error) {
        return;
      }

      if (result && result[0]) {
        this._pendingReload = true;
      }
    });
  }

  _appendNodes(menu, nodes) {
    let seenContent = false;

    for (let node of nodes) {
      if (!_isVisible(node)) {
        continue;
      }

      if (_isSeparator(node)) {
        if (seenContent) {
          menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        continue;
      }

      let item = this._createMenuItem(node, nodes);
      if (!item) {
        continue;
      }

      menu.addMenuItem(item);
      seenContent = true;
    }
  }

  _createMenuItem(node, siblings) {
    let label = _labelFor(node);
    if (!label) {
      return null;
    }

    if (_hasChildren(node)) {
      let submenu = new MenuWidgets.SideSubMenuMenuItem(label);
      this._appendNodes(submenu.menu, node.children || []);
      submenu.beforeOpen = (menu) => {
        this._beginMenuOpen();
        this._prepareOpen(node.id, menu, () => node.children || []);
      };
      submenu.afterClose = () => {
        this._endMenuOpen();
        this._sendEvent(node.id, PopupMenu.FactoryEventTypes.closed);
        this.flushPendingReload();
      };
      return submenu;
    }

    let enabled = node.properties.enabled !== false;
    let menuItem = new PopupMenu.PopupIndicatorMenuItem(label, {
      reactive: enabled,
      sensitive: enabled,
    });
    let toggleType = node.properties["toggle-type"] || null;
    let isToggle = false;

    if (toggleType === "checkmark") {
      menuItem.setOrnament(
        PopupMenu.OrnamentType.CHECK,
        _isToggled(node.properties["toggle-state"]),
      );
      isToggle = true;
    } else if (toggleType === "radio") {
      menuItem.setOrnament(
        PopupMenu.OrnamentType.DOT,
        _isToggled(node.properties["toggle-state"]),
      );
      isToggle = true;
    }

    _makeOrnamentPassive(menuItem);

    if (node.properties.accel) {
      menuItem.setAccel(node.properties.accel);
    }

    menuItem.connect("activate", () => {
      this._sendEvent(node.id, "clicked");

      if (toggleType === "checkmark") {
        let next = !_isToggled(node.properties["toggle-state"]);
        node.properties["toggle-state"] = next ? 1 : 0;
        menuItem.setOrnament(PopupMenu.OrnamentType.CHECK, next);
        _makeOrnamentPassive(menuItem);
      } else if (toggleType === "radio") {
        for (let sibling of siblings || []) {
          if (!sibling || sibling.properties["toggle-type"] !== "radio") {
            continue;
          }

          let selected = sibling === node;
          sibling.properties["toggle-state"] = selected ? 1 : 0;
          if (sibling._appmenuMenuItem) {
            sibling._appmenuMenuItem.setOrnament(
              PopupMenu.OrnamentType.DOT,
              selected,
            );
            _makeOrnamentPassive(sibling._appmenuMenuItem);
          }
        }
      }
    });
    menuItem.actor.add_style_class_name("appmenu-popup-item");
    menuItem._appmenuHoverId = MenuWidgets.bindHoverClass(menuItem);
    if (menuItem.label) {
      menuItem.label.add_style_class_name("appmenu-popup-label");
    }
    if (isToggle) {
      node._appmenuMenuItem = menuItem;
    }

    return menuItem;
  }

  _findNode(id, node) {
    if (!node) {
      return null;
    }
    if (node.id === id) {
      return node;
    }
    for (let child of node.children || []) {
      let found = this._findNode(id, child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  _sendEvent(id, event) {
    if (!this.proxy) {
      return;
    }

    this.proxy.EventRemote(
      id,
      event,
      GLib.Variant.new_int32(0),
      0,
      () => { },
    );
  }

  flushPendingReload() {
    if (!this._pendingReload) {
      return;
    }

    this._pendingReload = false;
    this._requestReload(50);
  }

  destroy() {
    if (this._refreshId) {
      GLib.source_remove(this._refreshId);
      this._refreshId = 0;
    }

    if (this.proxy) {
      if (this.layoutSignalId) {
        this.proxy.disconnectSignal(this.layoutSignalId);
        this.layoutSignalId = 0;
      }
      if (this.propertiesSignalId) {
        this.proxy.disconnectSignal(this.propertiesSignalId);
        this.propertiesSignalId = 0;
      }
      this.proxy = null;
    }

    this.root = null;
  }
};
