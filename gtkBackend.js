const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const PopupMenu = imports.ui.popupMenu;

const Utils = imports.utils;
const MenuWidgets = imports.menuWidgets;

var GtkMenusBackend = class GtkMenusBackend {
  constructor(applet, source) {
    this.applet = applet;
    this.busName = source.busName;
    this.objectPath = source.objectPath;
    this.applicationObjectPath = source.applicationObjectPath || null;
    this.windowObjectPath = source.windowObjectPath || null;
    this.unityObjectPath = source.unityObjectPath || null;
    this.menuProxy = null;
    this.menuSignalId = 0;
    this.actionProxies = {};
    this.actionSignalIds = {};
    this.reloadSerial = 0;
    this.startedGroups = [];
    this.groupMenus = {};
    this.actionDescriptions = {};
  }

  sameAs(source) {
    return (
      source &&
      source.type === "gtk" &&
      source.busName === this.busName &&
      source.objectPath === this.objectPath
    );
  }

  load() {
    this.menuProxy = new Utils.GtkMenusProxy(
      Gio.DBus.session,
      this.busName,
      this.objectPath,
      Lang.bind(this, function (proxy, error) {
        if (error) {
          global.logWarning(
            "Failed to create GTK menu proxy: " + error.message,
          );
          return;
        }

        this.menuSignalId = this.menuProxy.connectSignal("Changed", () =>
          this.reload(),
        );
        this._initActionProxies();
      }),
    );
  }

  reload() {
    if (!this.menuProxy) {
      return;
    }

    let serial = ++this.reloadSerial;
    this.groupMenus = {};
    this.actionDescriptions = {};

    if (this.startedGroups.length) {
      try {
        this.menuProxy.EndRemote(this.startedGroups, () => { });
      } catch (e) {
        global.logWarning(
          "Failed to end previous GTK menu groups: " + e.message,
        );
      }
      this.startedGroups = [];
    }

    this._loadActionDescriptions(serial, () => this._loadGroups(serial, [0], {}));
  }

  _loadGroups(serial, groupIds, seenGroups) {
    if (!groupIds.length) {
      this._publish(serial);
      return;
    }

    this.startedGroups = Array.from(
      new Set(this.startedGroups.concat(groupIds)),
    );

    this.menuProxy.StartRemote(
      groupIds,
      Lang.bind(this, function (result, error) {
        if (serial !== this.reloadSerial) {
          return;
        }

        if (error) {
          global.logWarning("Failed to read GTK menu groups: " + error.message);
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

              let [childGroupId] = Utils.variantToValue(item[key]);
              if (
                !seenGroups[childGroupId] &&
                !nextGroups.includes(childGroupId)
              ) {
                nextGroups.push(childGroupId);
              }
            }
          }
        }

        this._loadGroups(serial, nextGroups, seenGroups);
      }),
    );
  }

  _publish(serial) {
    if (serial !== this.reloadSerial) {
      return;
    }

    let rootRef = this._resolveRootRef([0, 0]);
    let items = this._getMenuItems(rootRef);
    let entries = [];

    for (let item of items) {
      let label = Utils.cleanMnemonic(Utils.variantToValue(item.label));
      if (!label) {
        continue;
      }

      if (item[":submenu"]) {
        let submenuRef = Utils.variantToValue(item[":submenu"]);
        entries.push({
          label,
          buildMenu: (menu) => {
            menu.removeAll();
            this._appendMenuRef(menu, submenuRef, false);
          },
          onOpen: (menu) => {
            menu.removeAll();
            this._appendMenuRef(menu, submenuRef, false);
          },
        });
        continue;
      }

      let detailedAction = Utils.variantToValue(item.action);
      let actionGroup = Utils.actionGroupFromDetailed(detailedAction);
      let actionName = Utils.actionNameFromDetailed(detailedAction);
      let target = item.target || null;

      entries.push({
        label,
        activate: actionName
          ? () => this._activateAction(actionGroup, actionName, target)
          : null,
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

      current = Utils.variantToValue(items[0][":section"]);
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
        let sectionRef = Utils.variantToValue(item[":section"]);
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
        count += this._countRenderableItems(Utils.variantToValue(item[":section"]));
      } else {
        count++;
      }
    }

    return count;
  }

  _createMenuItem(item) {
    let label = Utils.cleanMnemonic(Utils.variantToValue(item.label));
    if (!label) {
      return null;
    }

    if (item[":submenu"]) {
      let submenu = new MenuWidgets.SideSubMenuMenuItem(label);
      let submenuRef = Utils.variantToValue(item[":submenu"]);
      this._appendMenuRef(submenu.menu, submenuRef, false);
      submenu.beforeOpen = (menu) => {
        menu.removeAll();
        this._appendMenuRef(menu, submenuRef, false);
      };
      return submenu;
    }

    let detailedAction = Utils.variantToValue(item.action);
    let actionGroup = Utils.actionGroupFromDetailed(detailedAction);
    let actionName = Utils.actionNameFromDetailed(detailedAction);
    let actionInfo = actionName
      ? this._lookupActionInfo(actionGroup, actionName)
      : null;
    let enabled = actionInfo ? !!actionInfo[0] : true;
    let accel = Utils.cleanMnemonic(Utils.variantToValue(item.accel));
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
        let selected = Utils.variantToValue(currentState) === Utils.variantToValue(target);
        menuItem.setOrnament(PopupMenu.OrnamentType.DOT, selected);
      } else if (
        currentState.get_type_string &&
        currentState.get_type_string() === "b"
      ) {
        menuItem.setOrnament(
          PopupMenu.OrnamentType.CHECK,
          currentState.deep_unpack(),
        );
      }
    }

    if (actionName) {
      menuItem.connect("activate", () =>
        this._activateAction(actionGroup, actionName, target),
      );
    }

    menuItem.actor.add_style_class_name("appmenu-popup-item");
    menuItem._appmenuHoverId = MenuWidgets.bindHoverClass(menuItem);
    if (menuItem.label) {
      menuItem.label.add_style_class_name("appmenu-popup-label");
    }

    return menuItem;
  }

  _initActionProxies() {
    let actionPaths = {
      default: this.objectPath,
      app: this.applicationObjectPath,
      win: this.windowObjectPath,
      unity: this.unityObjectPath,
    };

    let pending = 0;
    let hasAny = false;

    for (let group in actionPaths) {
      let path = actionPaths[group];
      if (!path || this.actionProxies[group]) {
        continue;
      }

      hasAny = true;
      pending++;
      this.actionDescriptions[group] = {};
      this.actionProxies[group] = new Utils.GtkActionsProxy(
        Gio.DBus.session,
        this.busName,
        path,
        Lang.bind(this, function (actionsProxy, actionsError) {
          pending--;

          if (actionsError) {
            global.logWarning(
              `Failed to create GTK actions proxy for ${group}: ${actionsError.message}`,
            );
            delete this.actionProxies[group];
          } else {
            this.actionSignalIds[group] = this.actionProxies[group].connectSignal(
              "Changed",
              () => this.reload(),
            );
          }

          if (pending === 0) {
            this.reload();
          }
        }),
      );
    }

    if (!hasAny) {
      this.reload();
    }
  }

  _loadActionDescriptions(serial, callback) {
    let groups = Object.keys(this.actionProxies);
    if (!groups.length) {
      callback();
      return;
    }

    let remaining = groups.length;
    let finish = () => {
      remaining--;
      if (remaining === 0 && serial === this.reloadSerial) {
        callback();
      }
    };

    for (let group of groups) {
      this.actionDescriptions[group] = {};
      this.actionProxies[group].DescribeAllRemote(
        Lang.bind(this, function (result, error) {
          if (serial !== this.reloadSerial) {
            return;
          }

          if (error) {
            global.logWarning(
              `Failed to read GTK actions for ${group}: ${error.message}`,
            );
          } else {
            this.actionDescriptions[group] = result[0] || {};
          }

          finish();
        }),
      );
    }
  }

  _lookupActionInfo(actionGroup, actionName) {
    let groups = actionGroup
      ? [actionGroup, "default", "win", "app", "unity"]
      : ["default", "win", "app", "unity"];

    for (let group of groups) {
      let descriptions = this.actionDescriptions[group];
      if (descriptions && descriptions[actionName]) {
        return descriptions[actionName];
      }
    }

    return null;
  }

  _getActionProxy(actionGroup) {
    let groups = actionGroup
      ? [actionGroup, "default", "win", "app", "unity"]
      : ["default", "win", "app", "unity"];

    for (let group of groups) {
      if (this.actionProxies[group]) {
        return this.actionProxies[group];
      }
    }

    return null;
  }

  _activateAction(actionGroup, actionName, target) {
    let actionProxy = this._getActionProxy(actionGroup);
    if (!actionProxy) {
      return;
    }

    let parameters = target ? [target] : [];
    actionProxy.ActivateRemote(
      actionName,
      parameters,
      {},
      (result, error) => {
        if (error) {
          global.logWarning(
            `Failed to activate GTK action "${actionName}": ${error.message}`,
          );
          return;
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          this.reload();
          return GLib.SOURCE_REMOVE;
        });
      },
    );
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

    for (let group in this.actionProxies) {
      if (this.actionSignalIds[group]) {
        this.actionProxies[group].disconnectSignal(this.actionSignalIds[group]);
        this.actionSignalIds[group] = 0;
      }
    }

    this.menuProxy = null;
    this.actionProxies = {};
    this.actionSignalIds = {};
    this.startedGroups = [];
    this.groupMenus = {};
    this.actionDescriptions = {};
  }
};
