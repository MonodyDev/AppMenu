const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const WindowMenu = imports.ui.windowMenu;

function _bindHoverClass(menuItem) {
  if (!menuItem || !menuItem.actor) {
    return 0;
  }

  return menuItem.actor.connect("notify::hover", () => {
    if (menuItem.actor.hover) {
      menuItem.actor.add_style_class_name("appmenu-hover");
    } else {
      menuItem.actor.remove_style_class_name("appmenu-hover");
    }
  });
}

function _configureMenu(menu) {
  if (!menu || menu._appmenuConfigured) {
    return;
  }

  if (menu.setCustomStyleClass) {
    menu.setCustomStyleClass("appmenu-menu");
  }
  if (menu.box) {
    menu.box.add_style_class_name("appmenu-menu-content");
  }

  menu._appmenuConfigured = true;
}

var SideSubMenuMenuItem = class SideSubMenuMenuItem
  extends PopupMenu.PopupBaseMenuItem
{
  _init(text) {
    super._init.call(this);

    this._registeredAsChild = false;
    this._hoverCloseId = 0;
    this._openedAt = 0;
    this.beforeOpen = null;
    this.afterClose = null;

    this.actor.add_style_class_name("popup-submenu-menu-item");
    this.actor.add_style_class_name("appmenu-popup-item");
    this.actor.add_style_class_name("appmenu-popup-submenu-item");
    this._hoverClassId = _bindHoverClass(this);

    this.label = new St.Label({
      text: text,
      style_class: "appmenu-popup-label",
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._leadingBin = new St.Bin({
      style_class: "appmenu-popup-leading",
      x_align: St.Align.MIDDLE,
      y_align: St.Align.MIDDLE,
    });
    this.addActor(this._leadingBin, { span: 0 });

    this.addActor(this.label);
    this.actor.label_actor = this.label;

    this._triangleBin = new St.Bin({ x_align: St.Align.END });
    this.addActor(this._triangleBin, {
      expand: true,
      span: -1,
      align: St.Align.END,
    });

    this._triangle = PopupMenu.arrowIcon(St.Side.RIGHT);
    this._triangleBin.child = this._triangle;

    this.menu = new PopupMenu.PopupMenu(this.actor, St.Side.LEFT);
    _configureMenu(this.menu);
    Main.uiGroup.add_actor(this.menu.actor);
    this.menu.actor.hide();

    this._menuEnterEventId = this.menu.actor.connect("enter-event", () => {
      this._cancelScheduledClose();
      return Clutter.EVENT_PROPAGATE;
    });

    this._menuLeaveEventId = this.menu.actor.connect("leave-event", () => {
      this._scheduleCloseCheck();
      return Clutter.EVENT_PROPAGATE;
    });

    this._hoverNotifyId = this.actor.connect("notify::hover", () => {
      if (!this.actor.hover) {
        this._scheduleCloseCheck();
        return;
      }

      this._cancelScheduledClose();
      let topMenu = this._getTopMenu();
      if (!topMenu || !topMenu.isOpen) {
        return;
      }

      if (!this.menu.isOpen) {
        this._openSubmenu();
      }

      this._closeSiblingSubmenus();
    });

    this._enterEventId = this.actor.connect("enter-event", () => {
      this._cancelScheduledClose();
      return Clutter.EVENT_PROPAGATE;
    });

    this._motionEventId = this.actor.connect("motion-event", () => {
      let topMenu = this._getTopMenu();
      if (!topMenu || !topMenu.isOpen) {
        return Clutter.EVENT_PROPAGATE;
      }

      this._cancelScheduledClose();

      if (!this.menu.isOpen) {
        this._openSubmenu();
      } else {
        this._closeSiblingSubmenus();
      }

      return Clutter.EVENT_PROPAGATE;
    });

    this._leaveEventId = this.actor.connect("leave-event", () => {
      this._scheduleCloseCheck();
      return Clutter.EVENT_PROPAGATE;
    });

    this.menu.connect("open-state-changed", (menu, open) => {
      if (open) {
        this.actor.add_style_class_name("appmenu-submenu-open");
      } else {
        this.actor.remove_style_class_name("appmenu-submenu-open");
      }
      this.actor.change_style_pseudo_class("open", open);
      if (!open) {
        this._cancelScheduledClose();
      }
      if (!open && this.afterClose) {
        this.afterClose(menu, this);
      }
    });
  }

  _ensureChildRegistration() {
    if (this._registeredAsChild) return;
    let topMenu = this._getTopMenu();
    if (topMenu && topMenu.addChildMenu) {
      topMenu.addChildMenu(this.menu);
      this._registeredAsChild = true;
    }
  }

  _closeSiblingSubmenus() {
    let parent = this.actor.get_parent();
    if (!parent) {
      return;
    }

    for (let child of parent.get_children()) {
      if (
        child !== this.actor &&
        child._delegate &&
        child._delegate instanceof SideSubMenuMenuItem &&
        child._delegate.menu &&
        child._delegate.menu.isOpen
      ) {
        child._delegate.menu.close();
      }
    }
  }

  _openSubmenu() {
    this._ensureChildRegistration();
    this._closeSiblingSubmenus();
    this._cancelScheduledClose();

    if (!this.menu.isOpen && this.beforeOpen) {
      this.beforeOpen(this.menu, this);
    }

    if (!this.menu.isOpen) {
      this._openedAt = Date.now();
      this.menu.open(false);
    }
  }

  _scheduleCloseCheck() {
    this._cancelScheduledClose();
    this._hoverCloseId = Mainloop.timeout_add(280, () => {
      this._hoverCloseId = 0;

      if (!this.menu || !this.menu.isOpen) {
        return false;
      }

      if (this._openedAt && Date.now() - this._openedAt < 350) {
        this._scheduleCloseCheck();
        return false;
      }

      if (this._isPointerInsideChain()) {
        return false;
      }

      this.menu.close(false);
      return false;
    });
  }

  _cancelScheduledClose() {
    if (this._hoverCloseId) {
      Mainloop.source_remove(this._hoverCloseId);
      this._hoverCloseId = 0;
    }
  }

  _isPointerInsideChain() {
    if (
      this._actorContainsPointer(this.actor) ||
      (this.menu &&
        this.menu.actor &&
        this._actorContainsPointer(this.menu.actor))
    ) {
      return true;
    }

    return this._hasHoveredOpenChild(this.menu);
  }

  _hasHoveredOpenChild(menu) {
    if (!menu || !menu._childMenus) {
      return false;
    }

    for (let childMenu of menu._childMenus) {
      if (!childMenu || !childMenu.sourceActor) {
        continue;
      }

      if (
        this._actorContainsPointer(childMenu.sourceActor) ||
        this._actorContainsPointer(childMenu.actor)
      ) {
        return true;
      }

      if (this._hasHoveredOpenChild(childMenu)) {
        return true;
      }
    }

    return false;
  }

  _actorContainsPointer(actor) {
    if (
      !actor ||
      !actor.visible ||
      (actor.is_finalized && actor.is_finalized())
    ) {
      return false;
    }

    let [pointerX, pointerY] = global.get_pointer();
    let [actorX, actorY] = actor.get_transformed_position();
    let [actorWidth, actorHeight] = actor.get_transformed_size();

    return (
      pointerX >= actorX &&
      pointerX < actorX + actorWidth &&
      pointerY >= actorY &&
      pointerY < actorY + actorHeight
    );
  }

  _getTopMenu() {
    let actor = this.actor.get_parent();
    while (actor) {
      if (
        actor._delegate &&
        (actor._delegate instanceof PopupMenu.PopupMenu ||
          actor._delegate instanceof PopupMenu.PopupSubMenu)
      ) {
        if (actor._delegate instanceof PopupMenu.PopupMenu) {
          return actor._delegate;
        }
        let topMenu = actor._delegate._getTopMenu
          ? actor._delegate._getTopMenu()
          : null;
        if (topMenu) return topMenu;
      }
      actor = actor.get_parent();
    }
    return null;
  }

  destroy() {
    this._cancelScheduledClose();
    if (this.menu && this._menuEnterEventId) {
      this.menu.actor.disconnect(this._menuEnterEventId);
      this._menuEnterEventId = 0;
    }
    if (this.menu && this._menuLeaveEventId) {
      this.menu.actor.disconnect(this._menuLeaveEventId);
      this._menuLeaveEventId = 0;
    }
    if (this.menu) {
      this.menu.destroy();
      this.menu = null;
    }
    if (this.actor && this._enterEventId) {
      this.actor.disconnect(this._enterEventId);
      this._enterEventId = 0;
    }
    if (this.actor && this._motionEventId) {
      this.actor.disconnect(this._motionEventId);
      this._motionEventId = 0;
    }
    if (this.actor && this._hoverNotifyId) {
      this.actor.disconnect(this._hoverNotifyId);
      this._hoverNotifyId = 0;
    }
    if (this.actor && this._hoverClassId) {
      this.actor.disconnect(this._hoverClassId);
      this._hoverClassId = 0;
    }
    if (this.actor && this._leaveEventId) {
      this.actor.disconnect(this._leaveEventId);
      this._leaveEventId = 0;
    }
    super.destroy.call(this);
  }

  activate(event) {
    if (this.menu.isOpen) {
      this.menu.close();
    } else {
      this._openSubmenu();
    }
  }
};

var bindHoverClass = _bindHoverClass;

var PanelMenuButton = class PanelMenuButton {
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
      style_class:
        "applet-label appmenu-panel-label" +
        (entry.styleClass ? " " + entry.styleClass : ""),
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.actor.add_actor(this.label);

    if (entry.buildMenu) {
      this.menu = new PopupMenu.PopupMenu(this.actor, this.applet.orientation);
      _configureMenu(this.menu);
      Main.uiGroup.add_actor(this.menu.actor);
      this.menu.actor.hide();
      this.applet._menuManager.addMenu(this.menu);

      entry.buildMenu(this.menu, this);

      this._menuOpenId = this.menu.connect(
        "open-state-changed",
        (menu, open) => {
          this.actor.change_style_pseudo_class("checked", open);
          if (open) {
            this._prepareMenuAlignment();
            if (this.entry.onOpen) {
              this.entry.onOpen(menu, this);
            }
          } else if (this.entry.onClose) {
            this.entry.onClose(menu, this);
          }
        },
      );
    } else {
      this._menuOpenId = 0;
    }

    this._buttonReleaseId = this.actor.connect("button-release-event", () => {
      if (this.menu) {
        if (!this.menu.isOpen && this.entry.beforeOpen) {
          this.entry.beforeOpen(this.menu, this);
        }
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

    if (
      this.applet.orientation !== St.Side.TOP &&
      this.applet.orientation !== St.Side.BOTTOM
    ) {
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
};
